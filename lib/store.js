/**
 * Persistent state for Voice Studio.
 *
 * Everything lives in one directory:
 *
 *   <dataDir>/config.json          settings (atomic writes, serialised)
 *   <dataDir>/refs/<id>.<ext>      reference voices copied into the plugin
 *   <dataDir>/out/                 generated audio + cover output
 *   <dataDir>/tmp/<job>/           per-run scratch (separation / RVC / mix)
 *
 * Reference audio is deliberately *copied* into `refs/`, never referenced in
 * place: the settings page can then manage, replace and delete one library
 * without touching the user's own folders.
 */
import { mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  ensureDir,
  existsSync,
  fileSize,
  homePath,
  readJsonFile,
  run,
  uid,
  writeJsonAtomicSync,
} from './util.js'

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.wma', '.aiff', '.aif'])

export function dataDir() {
  const override = process.env.DSH_VOICE_STUDIO_DATA
  if (override && override.trim()) return override.trim()
  return homePath('.dsh-voice-studio')
}

export function refsDir() {
  return join(dataDir(), 'refs')
}

export function outDir() {
  return join(dataDir(), 'out')
}

export function tmpRoot() {
  return join(dataDir(), 'tmp')
}

export function isAudioFile(name) {
  return AUDIO_EXT.has(extname(String(name)).toLowerCase())
}

/** Candidate RVC roots probed by the "auto detect" action. */
const RVC_CANDIDATES = [
  'D:\\keduoli_desk\\rvc\\RVC20260718Nvidia',
  'D:\\keduoli_desk\\rvc',
  'C:\\RVC',
  'D:\\RVC',
  'E:\\RVC',
  homePath('rvc'),
]

export function defaultConfig() {
  return {
    version: 1,
    tts: {
      provider: 'indextts',
      providers: {
        indextts: {
          baseUrl: 'http://127.0.0.1:7860',
          refAudioId: '',
          lang: 'ZH',
          emoMode: 'auto',
          emoWeight: 0.8,
          durationFactor: 1,
        },
        gptsovits: {
          baseUrl: 'http://127.0.0.1:9880',
          refAudioId: '',
          promptText: '',
          promptLang: 'zh',
          textLang: 'zh',
          speed: 1,
        },
        siliconflow: {
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: '',
          model: 'FunAudioLLM/CosyVoice2-0.5B',
          voice: 'speech:auto',
        },
        minimax: {
          baseUrl: 'https://api.minimax.chat/v1',
          apiKey: '',
          groupId: '',
          model: 'speech-02-hd',
          voice: 'female-shaonv',
        },
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
        },
      },
    },
    emotion: {
      // auto: ask a DSH emotion capability if one is registered, else use the
      // built-in lexicon. off: never add emotion. manual: only when a caller
      // passes it explicitly.
      mode: 'auto',
      intensity: 0.6,
    },
    qq: {
      enabled: false,
      // bridge: render -> copy into qq-bridge's voice library -> call its
      // qq_send_voice tool. This is the deployed setup and the default.
      // onebot-http / shell are legacy fallbacks, auto tries bridge first.
      mode: 'bridge',
      // qq-bridge checkout root; empty autodetects the usual locations.
      bridgeRoot: '',
      // Media fence of a direct-tool setup (dsh-onebot-qq). Left empty means
      // <DSH_HOME>/media/onebot.
      mediaDir: '',
      baseUrl: 'http://127.0.0.1:3000',
      accessToken: '',
      targetType: 'private', // private | group
      targetId: '',
      sendAs: 'record', // record (voice) | file
      shellTemplate: '',
    },
    cover: {
      rvcRoot: '',
      rvcPython: '',
      // Empty by default: separation then uses the RVC bundle's own PyMSS.
      // A URL is only needed when the user really runs MSST_WebUI.
      msstUrl: '',
      loudness: 'I=-11.5:TP=-1.0:LRA=11',
      model: '',
      index: '',
      f0Method: 'rmvpe',
      f0UpKey: 0,
      indexRate: 0.75,
      rmsMix: 0.25,
      protect: 0.33,
      musicDirs: [],
      ytdlpPath: '',
      allowDownload: false,
      ffmpegPath: '',
      maxSeconds: 0,
    },
    // Random voice replies: occasionally answer with speech instead of text.
    // The agent asks `voice_random_check` before a reply; this block is both the
    // policy and the cooldown ledger. Songs never go through this path.
    autoVoice: {
      enabled: true,
      probability: 0.12,
      cooldownSec: 600,
      maxPerHour: 6,
      lastAt: 0,
      history: [],
    },
    voices: [],
    ui: { tab: 'tts' },
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge `patch` into `target`, keeping anything the patch omits. */
function deepMergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMergeInto(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

function mergeDefaults(base, saved) {
  if (!isPlainObject(saved)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in base)) continue
    if (isPlainObject(base[key]) && isPlainObject(value)) {
      out[key] = mergeDefaults(base[key], value)
    } else if (Array.isArray(base[key])) {
      out[key] = Array.isArray(value) ? value : base[key]
    } else {
      out[key] = value
    }
  }
  return out
}

export class Store {
  constructor() {
    this.dir = dataDir()
    ensureDir(this.dir)
    ensureDir(refsDir())
    ensureDir(outDir())
    ensureDir(tmpRoot())
    this.configFile = join(this.dir, 'config.json')
    this.config = defaultConfig()
    this.writeQueue = Promise.resolve()
    this.loaded = false
  }

  async load() {
    const saved = await readJsonFile(this.configFile, {})
    this.config = mergeDefaults(defaultConfig(), saved)
    if (!Array.isArray(this.config.voices)) this.config.voices = []
    this.loaded = true
    return this.config
  }

  read() {
    return this.config
  }

  /** Serialised read-modify-write so two settings saves cannot drop each other. */
  async update(mutator) {
    const next = this.writeQueue.then(async () => {
      const draft = mergeDefaults(defaultConfig(), this.config)
      const result = await mutator(draft)
      this.config = draft
      writeJsonAtomicSync(this.configFile, draft)
      return result
    })
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }

  async saveSection(section, patch) {
    return this.update((draft) => {
      if (!isPlainObject(patch)) throw Object.assign(new Error('settings must be an object'), { code: 'BAD_SETTINGS' })
      draft[section] = mergeDefaults(draft[section] ?? {}, patch)
      return draft[section]
    })
  }

  async replace(patch) {
    return this.update((draft) => {
      if (!isPlainObject(patch)) throw Object.assign(new Error('settings must be an object'), { code: 'BAD_SETTINGS' })
      // A patch only carries the fields the page/agent changed. Merging it over
      // the defaults instead of the current draft would silently reset sections
      // the patch never mentioned (notably the reference voice library).
      deepMergeInto(draft, patch)
      return draft
    })
  }

  outDir() {
    return outDir()
  }

  tmpRoot() {
    return tmpRoot()
  }

  // ---- reference voice library -------------------------------------------

  listVoices() {
    const voices = Array.isArray(this.config.voices) ? this.config.voices : []
    return voices.map((voice) => ({
      ...voice,
      available: this.voicePath(voice.id) !== null,
    }))
  }

  voicePath(id) {
    const voice = this.findVoice(id)
    if (!voice) return null
    const file = join(refsDir(), voice.file)
    return existsSync(file) ? file : null
  }

  findVoice(id) {
    if (!id) return null
    return (this.config.voices || []).find((voice) => voice.id === id) || null
  }

  voiceByIdOrName(idOrName) {
    if (!idOrName) return null
    return this.findVoice(idOrName)
      || (this.config.voices || []).find((voice) => voice.name === idOrName)
      || null
  }

  findByNameOrFile(name, fileName) {
    const lowerName = String(name || '').trim().toLowerCase()
    const lowerFile = String(fileName || '').trim().toLowerCase()
    return (this.config.voices || []).find((voice) => {
      if (lowerName && String(voice.name || '').toLowerCase() === lowerName) return true
      if (lowerFile && String(voice.originalFile || '').toLowerCase() === lowerFile) return true
      return false
    }) || null
  }

  async probeDuration(file) {
    const ffprobe = this.ffprobePath()
    if (!ffprobe) return null
    try {
      const { code, stdout } = await run(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        file,
      ], { timeoutMs: 20000 })
      if (code !== 0) return null
      const value = Number.parseFloat(stdout.trim())
      return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
    } catch {
      return null
    }
  }

  ffprobePath() {
    const root = this.config.cover?.rvcRoot
    if (root) {
      const candidate = join(root, 'ffprobe.exe')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  ffmpegPath() {
    const configured = this.config.cover?.ffmpegPath
    if (configured && existsSync(configured)) return configured
    const root = this.config.cover?.rvcRoot
    if (root) {
      const candidate = join(root, 'ffmpeg.exe')
      if (existsSync(candidate)) return candidate
    }
    return 'ffmpeg'
  }

  /**
   * Add one reference voice.
   *
   * `mode` decides the outcome when the library already holds a voice with the
   * same display name or the same original filename:
   *   - 'ask'     鈫?throws { code: 'VOICE_CONFLICT', existing } so the page can
   *                 offer replace / add-as-new / cancel (this is the default
   *                 the page sends; the tools never guess for the user)
   *   - 'replace' 鈫?overwrites that entry's audio, keeps its id
   *   - 'add'     鈫?keeps both; the new display name gets a numeric suffix
   */
  async addVoice({ buffer, sourcePath, name, originalFile, mode = 'ask', replaceId }) {
    let bytes = buffer
    let file = originalFile
    if (!bytes) {
      if (!sourcePath || !existsSync(sourcePath)) {
        throw Object.assign(new Error('reference audio not found'), { code: 'VOICE_MISSING_FILE' })
      }
      const info = statSync(sourcePath)
      if (!info.isFile()) throw Object.assign(new Error('reference audio is not a file'), { code: 'VOICE_MISSING_FILE' })
      bytes = await readFile(sourcePath)
      file = file || basename(sourcePath)
    }
    if (!file) file = `voice${extname(sourcePath || '') || '.wav'}`
    if (!isAudioFile(file)) {
      throw Object.assign(new Error(`unsupported reference audio extension: ${extname(file) || '(none)'}`), {
        code: 'VOICE_BAD_EXT',
      })
    }
    const displayName = String(name || basename(file, extname(file))).trim() || 'reference'
    const existing = replaceId ? this.findVoice(replaceId) : this.findByNameOrFile(displayName, file)
    if (existing && mode === 'ask' && !replaceId) {
      throw Object.assign(new Error(`voice already exists: ${existing.name}`), {
        code: 'VOICE_CONFLICT',
        status: 409,
        existing: { ...existing },
      })
    }
    ensureDir(refsDir())
    const ext = extname(file).toLowerCase()
    if (existing && (mode === 'replace' || replaceId)) {
      const target = join(refsDir(), existing.file)
      await writeFile(target, bytes)
      const durationSec = await this.probeDuration(target)
      await this.update((draft) => {
        const voice = (draft.voices || []).find((item) => item.id === existing.id)
        if (voice) {
          voice.size = bytes.length
          voice.durationSec = durationSec ?? voice.durationSec ?? null
          voice.updatedAt = new Date().toISOString()
          voice.sourcePath = sourcePath || voice.sourcePath
        }
      })
      return { voice: this.findVoice(existing.id), replaced: true }
    }
    let finalName = displayName
    let counter = 2
    while ((this.config.voices || []).some((voice) => voice.name === finalName)) {
      finalName = `${displayName} (${counter})`
      counter += 1
    }
    const id = uid('v_')
    const storedName = `${id}${ext}`
    const target = join(refsDir(), storedName)
    await writeFile(target, bytes)
    const durationSec = await this.probeDuration(target)
    const voice = {
      id,
      name: finalName,
      file: storedName,
      originalFile: file,
      ext,
      size: bytes.length,
      durationSec: durationSec ?? null,
      sourcePath: sourcePath || null,
      addedAt: new Date().toISOString(),
    }
    await this.update((draft) => {
      draft.voices = [...(draft.voices || []), voice]
    })
    return { voice, replaced: false }
  }

  async importDir(dirPath, { recursive = true, mode = 'ask', maxDepth = 3 } = {}) {
    if (!existsSync(dirPath)) throw Object.assign(new Error(`directory not found: ${dirPath}`), { code: 'DIR_MISSING' })
    const collected = []
    const walk = (current, depth) => {
      if (depth > maxDepth) return
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (recursive) walk(full, depth + 1)
          continue
        }
        if (isAudioFile(entry.name)) collected.push(full)
      }
    }
    walk(dirPath, 0)
    collected.sort()
    const added = []
    const skipped = []
    for (const file of collected.slice(0, 200)) {
      try {
        const result = await this.addVoice({
          sourcePath: file,
          name: basename(file, extname(file)),
          originalFile: basename(file),
          mode: mode === 'replace' ? 'replace' : 'add',
        })
        added.push(result.voice)
      } catch (error) {
        skipped.push({ file: basename(file), error: String(error?.message || error) })
      }
    }
    return { found: collected.length, added, skipped }
  }

  async deleteVoice(id) {
    const voice = this.findVoice(id)
    if (!voice) return { removed: false }
    const file = join(refsDir(), voice.file)
    await this.update((draft) => {
      draft.voices = (draft.voices || []).filter((item) => item.id !== id)
      for (const provider of Object.values(draft.tts?.providers ?? {})) {
        if (provider && provider.refAudioId === id) provider.refAudioId = ''
      }
    })
    await writeFile(join(this.dir, 'deleted.log'), `${new Date().toISOString()} ${voice.file}\n`, { flag: 'a' }).catch(() => {})
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(file)
    } catch {
      /* already gone */
    }
    return { removed: true }
  }

  async renameVoice(id, name) {
    const clean = String(name || '').trim()
    if (!clean) throw Object.assign(new Error('name required'), { code: 'BAD_NAME' })
    return this.update((draft) => {
      const voice = (draft.voices || []).find((item) => item.id === id)
      if (!voice) throw Object.assign(new Error('voice not found'), { code: 'NOT_FOUND' })
      voice.name = clean
      return voice
    })
  }

  // ---- RVC models ---------------------------------------------------------

  /** Every usable `.pth` under `assets/weights`, plus the log checkpoints. */
  listRvcModels() {
    const root = this.config.cover?.rvcRoot
    if (!root || !existsSync(root)) return { root: root || '', models: [], indexes: [], error: root ? 'RVC root not found' : 'RVC root not configured' }
    const models = []
    const weightsDir = join(root, 'assets', 'weights')
    if (existsSync(weightsDir)) {
      for (const entry of readdirSync(weightsDir, { withFileTypes: true })) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.pth') continue
        const full = join(weightsDir, entry.name)
        models.push({
          id: entry.name,
          name: basename(entry.name, '.pth'),
          path: full,
          kind: 'weights',
          size: fileSize(full),
          mtime: safeMtime(full),
        })
      }
    }
    const logsDir = join(root, 'logs')
    if (existsSync(logsDir)) {
      for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const experimentDir = join(logsDir, entry.name)
        let files = []
        try {
          files = readdirSync(experimentDir).filter((name) => /^G_.*\.pth$/i.test(name))
        } catch {
          continue
        }
        files.sort((a, b) => safeMtime(join(experimentDir, b)) - safeMtime(join(experimentDir, a)))
        if (files.length === 0) continue
        const full = join(experimentDir, files[0])
        models.push({
          id: `logs/${entry.name}/${files[0]}`,
          name: `${entry.name}/${files[0].replace(/\.pth$/i, '')}`,
          path: full,
          kind: 'checkpoint',
          size: fileSize(full),
          mtime: safeMtime(full),
        })
      }
    }
    models.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'weights' ? -1 : 1))
    const indexes = this.listRvcIndexes(root)
    return { root, models, indexes, error: null }
  }

  listRvcIndexes(root = this.config.cover?.rvcRoot) {
    const out = []
    if (!root) return out
    const logsDir = join(root, 'logs')
    if (!existsSync(logsDir)) return out
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
        } else if (extname(entry.name).toLowerCase() === '.index') {
          out.push({
            id: full.slice(root.length + 1).replace(/\\/g, '/'),
            name: entry.name,
            path: full,
            size: fileSize(full),
            trained: /trained/i.test(entry.name),
          })
        }
      }
    }
    walk(logsDir, 0)
    out.sort((a, b) => Number(a.trained) - Number(b.trained) || a.name.localeCompare(b.name))
    return out
  }

  /** Pick the index that belongs to a model, preferring the "added" variant. */
  autoIndexFor(modelId, indexes) {
    const stem = String(modelId || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .replace(/\.pth$/i, '')
      .replace(/_e\d+_s\d+$/i, '')
    if (!stem) return ''
    const candidates = (indexes || []).filter((index) => {
      const lower = index.name.toLowerCase()
      return !lower.includes('trained') && lower.includes(stem.toLowerCase())
    })
    const preferred = candidates.find((index) => /added/i.test(index.name))
    return (preferred || candidates[0])?.path || ''
  }

  /** qq-bridge checkout root (configured, else detected). */
  bridgeRoot() {
    const configured = String(this.config.qq?.bridgeRoot || '').trim()
    if (configured && existsSync(join(configured, 'config.json'))) return configured
    const candidates = [
      'D:\\keduoli_desk\\qq-bridge',
      'C:\\qq-bridge',
      join(homedir(), 'qq-bridge'),
      join(homedir(), 'Documents', 'qq-bridge'),
    ]
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'config.json')) && existsSync(join(candidate, 'src', 'bridge.js'))) {
        return candidate
      }
    }
    return configured || ''
  }

  detectRvcRoot() {
    for (const candidate of RVC_CANDIDATES) {
      if (!existsSync(candidate)) continue
      if (existsSync(join(candidate, 'assets', 'weights')) || existsSync(join(candidate, 'webui.py'))) return candidate
    }
    return ''
  }

  detectRvcPython(root) {
    const configured = this.config.cover?.rvcPython
    if (configured && existsSync(configured)) return configured
    if (!root) return ''
    const candidates = [
      join(root, 'runtime', 'python.exe'),
      join(root, '.venv', 'Scripts', 'python.exe'),
      join(root, 'venv', 'Scripts', 'python.exe'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return ''
  }
}

function safeMtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export { copyFileSync }

