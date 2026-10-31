/**
 * Song-cover pipeline: locate the song → separate → RVC → mix.
 *
 * Order matters and is deliberate:
 *
 *   1. the song is *found first* (local library match, explicit path, or a
 *      download when the user enabled it) — a cover request names a song, not
 *      a file path;
 *   2. separation uses MSST_WebUI when configured, otherwise the RVC bundle's
 *      own PyMSS models, so the feature never hard-depends on a second app;
 *   3. RVC conversion reuses the proven headless worker (no WebUI port);
 *   4. mixing matches the converted vocal's loudness to the separated vocal
 *      stem, which keeps the original vocal/instrument balance.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  brief,
  ensureDir,
  fetchBytes,
  fetchJson,
  probe,
  removeFile,
  run,
  uid,
} from './util.js'
import { fetchGradioFile, gradioCall, gradioFilePath, gradioUpload } from './tts.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = join(HERE, '..', 'worker')

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.aiff', '.wma'])

function isAudio(path) {
  return AUDIO_EXT.has(extname(path).toLowerCase())
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[（）()·、,，.。!！?？:：'"“”‘’\s_-]/g, '')
}

/** Score one candidate path against the requested song name. */
function scoreCandidate(candidate, wanted) {
  const stem = normalize(basename(candidate, extname(candidate)))
  const target = normalize(wanted)
  if (!stem || !target) return 0
  if (stem === target) return 100
  if (stem.includes(target)) return 60 + Math.min(20, target.length / 2)
  if (target.includes(stem)) return 40 + Math.min(20, stem.length / 2)
  const targetChars = new Set(target.split(''))
  let hit = 0
  for (const char of stem) if (targetChars.has(char)) hit += 1
  const ratio = hit / Math.max(stem.length, target.length)
  return ratio > 0.6 ? Math.round(ratio * 30) : 0
}

/**
 * Resolve a user's song request to one audio file.
 * @returns {Promise<{file: string, source: string, candidates: Array<{path: string, score: number}>, matchedBy: string}>}
 */
export async function resolveSong(input, config, tmpDir) {
  const wanted = String(input || '').trim()
  if (!wanted) throw Object.assign(new Error('song is required'), { code: 'BAD_SONG' })

  if (existsSync(wanted) && statSync(wanted).isFile() && isAudio(wanted)) {
    return { file: wanted, source: 'path', candidates: [], matchedBy: 'path' }
  }

  if (/^https?:\/\//i.test(wanted)) {
    if (!config.cover?.allowDownload) {
      throw Object.assign(new Error('给了链接但未允许下载歌曲：请在设置页打开「允许下载歌曲」并填写 yt-dlp 路径'), { code: 'DOWNLOAD_DISABLED' })
    }
    const ytdlp = config.cover?.ytdlpPath
    if (!ytdlp || !existsSync(ytdlp)) {
      throw Object.assign(new Error('未配置可用的 yt-dlp 路径'), { code: 'NO_YTDLP' })
    }
    ensureDir(tmpDir)
    const template = join(tmpDir, '%(title)s.%(ext)s')
    const { code, stderr } = await run(ytdlp, ['-x', '--audio-format', 'wav', '-o', template, wanted], {
      timeoutMs: 15 * 60 * 1000,
    })
    if (code !== 0) throw Object.assign(new Error(`yt-dlp 下载失败：${brief(stderr, 400)}`), { code: 'DOWNLOAD_FAILED' })
    const files = readdirSync(tmpDir).filter(isAudio)
    if (files.length === 0) throw Object.assign(new Error('下载完成但找不到音频文件'), { code: 'DOWNLOAD_EMPTY' })
    const file = join(tmpDir, files[0])
    return { file, source: 'download', candidates: [], matchedBy: 'download' }
  }

  const dirs = Array.isArray(config.cover?.musicDirs) ? config.cover.musicDirs : []
  if (dirs.length === 0) {
    throw Object.assign(new Error(`找不到歌曲「${wanted}」：请给绝对路径/链接，或在设置页添加音乐目录`), { code: 'SONG_NOT_FOUND' })
  }
  const found = []
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue
    const walk = (current, depth) => {
      if (depth > 4 || found.length > 400) return
      let entries = []
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        if (!isAudio(entry.name)) continue
        const score = scoreCandidate(full, wanted)
        if (score > 0) found.push({ path: full, score })
      }
    }
    walk(dir, 0)
  }
  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  if (found.length === 0) {
    throw Object.assign(new Error(`在音乐目录里没找到「${wanted}」`), { code: 'SONG_NOT_FOUND' })
  }
  return { file: found[0].path, source: 'library', candidates: found.slice(0, 8), matchedBy: `library(${found[0].score})` }
}

/** MSST_WebUI separation through its Gradio API. */
async function separateWithMsst(song, msstUrl, tmpDir) {
  const base = msstUrl.replace(/\/$/, '')
  const reachable = await probe(`${base}/config`, 5000)
  if (!reachable.ok) throw new Error(`MSST_WebUI 不可达：${base}`)

  const config = await fetchJson(`${base}/config`, { timeoutMs: 15000 }).catch(() => null)
  const deps = Array.isArray(config?.dependencies) ? config.dependencies : []
  const fn = deps.find((item) => item?.api_name === '/run_inference_single' || item?.api_name === 'run_inference_single')
    || deps.find((item) => typeof item?.api_name === 'string' && item.api_name.includes('inference_single'))
  if (!fn) throw new Error('MSST_WebUI 没有 run_inference_single 接口（版本不匹配）')

  const storeDir = join(tmpDir, 'msst')
  ensureDir(storeDir)
  const fileData = await gradioUpload(base, song)

  // Take the app's own defaults for the parameters we do not control (the
  // separation model and the GPU list). Passing `undefined` would serialise to
  // null and the endpoint rejects a null model.
  const info = await fetchJson(`${base}/info`, { timeoutMs: 15000 }).catch(() => null)
  const params = info?.named_endpoints?.['/run_inference_single']?.parameters || []
  const byName = Object.fromEntries(params.map((param) => [param.parameter_name, param]))
  const defaultModel = byName.selected_model?.parameter_default
  const defaultGpu = byName.gpu_id?.parameter_default
  if (!defaultModel) throw new Error('MSST_WebUI 没有可用的分离模型（/info 未给出默认值）')
  const data = [
    defaultModel, // selected_model
    [fileData], // input_audio
    storeDir, // store_dir
    ['dry'], // extract_instrumental
    Array.isArray(defaultGpu) && defaultGpu.length ? defaultGpu : [], // gpu_id
    'wav', // output_format
    false, // force_cpu
    false, // use_tta
  ]
  await gradioCall(base, String(fn.api_name || 'run_inference_single').replace(/^\//, ''), data, { timeoutMs: 30 * 60 * 1000 })

  const files = []
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
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (isAudio(entry.name)) files.push(full)
    }
  }
  walk(storeDir, 0)
  const vocal = files.find((file) => /vocal|dry/i.test(basename(file)))
  const instrumental = files.find((file) => /instrument|other|no_vocal/i.test(basename(file)))
  if (!vocal || !instrumental) {
    throw new Error(`MSST 输出里没有同时找到人声与伴奏（拿到 ${files.length} 个文件）`)
  }
  return { vocal, instrumental, engine: 'MSST_WebUI' }
}

/** Built-in separation through the RVC bundle's PyMSS models. */
async function separateWithRvc(song, config, tmpDir, python) {
  const argsFile = join(tmpDir, 'separate.args.json')
  await writeFile(argsFile, JSON.stringify({
    rvcRoot: config.cover.rvcRoot,
    tempDir: join(tmpDir, 'tmp'),
    song,
    model: config.cover?.separationModel || '',
  }))
  const { code, stdout, stderr } = await run(python, [join(WORKER_DIR, 'pymss_separate.py'), argsFile], {
    cwd: config.cover.rvcRoot,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 40 * 60 * 1000,
  })
  const result = parseWorkerJson(stdout)
  if (code !== 0 || !result?.ok) {
    throw new Error(`RVC 内置分离失败：${brief(result?.error || stderr || stdout, 600)}`)
  }
  return { vocal: result.vocal, instrumental: result.instrumental, engine: `RVC PyMSS(${result.model || '默认'})` }
}

function parseWorkerJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      return JSON.parse(text)
    } catch {
      /* try an earlier line */
    }
  }
  return null
}

/**
 * Run a full cover.
 *
 * @param {object} options
 * @param {import('./store.js').Store} options.store
 * @param {string} options.song        song name, path or URL
 * @param {string} [options.model]     RVC model id (as listed) or absolute .pth
 * @param {string} [options.index]     index path; '' = auto-resolve
 * @param {number} [options.f0UpKey]   semitone shift
 * @param {(stage: string, detail?: object) => void} [options.onProgress]
 */
export async function makeCover({ store, song, model, index, f0UpKey, onProgress }) {
  const config = store.read()
  const cover = config.cover || {}
  const report = (stage, detail = {}) => {
    try {
      onProgress?.(stage, detail)
    } catch {
      /* progress must never break the work */
    }
  }

  const root = cover.rvcRoot
  if (!root || !existsSync(root)) {
    throw Object.assign(new Error('未配置 RVC 根目录（设置 → 语音工坊 → 翻唱）'), { code: 'NO_RVC' })
  }
  const python = store.detectRvcPython(root)
  if (!python) throw Object.assign(new Error('未找到 RVC 的 Python（runtime/python.exe 或 .venv）'), { code: 'NO_RVC_PYTHON' })

  const models = store.listRvcModels()
  let modelPath = ''
  let modelLabel = ''
  const wanted = String(model || cover.model || '').trim()
  if (wanted && existsSync(wanted)) {
    modelPath = wanted
    modelLabel = basename(wanted, '.pth')
  } else if (wanted) {
    const found = models.models.find((item) => item.id === wanted || item.path === wanted || item.name === wanted)
    if (!found) throw Object.assign(new Error(`RVC 模型不存在：${wanted}`), { code: 'MODEL_NOT_FOUND' })
    modelPath = found.path
    modelLabel = found.name
  } else if (models.models.length > 0) {
    modelPath = models.models[0].path
    modelLabel = models.models[0].name
  }
  if (!modelPath) throw Object.assign(new Error('没有可用的 RVC .pth 模型（assets/weights 为空）'), { code: 'NO_MODEL' })

  let indexPath = index !== undefined && index !== null && index !== '' ? String(index) : String(cover.index || '')
  if (!indexPath || !existsSync(indexPath)) {
    indexPath = store.autoIndexFor(modelPath, models.indexes)
  }
  if (indexPath && !existsSync(indexPath)) indexPath = ''

  const jobDir = ensureDir(join(store.tmpRoot(), uid('cover_')))
  const started = Date.now()

  report('locate', { song })
  const located = await resolveSong(song, config, join(jobDir, 'download'))
  report('locate.done', { file: located.file, source: located.source })

  report('separate', { engine: cover.msstUrl ? 'MSST_WebUI' : 'RVC PyMSS' })
  let stems
  let separationNote = ''
  if (cover.msstUrl) {
    try {
      stems = await separateWithMsst(located.file, cover.msstUrl, jobDir)
    } catch (error) {
      separationNote = `MSST 失败（${brief(error?.message || error, 200)}），已自动回退到 RVC 内置分离`
      report('separate.fallback', { reason: brief(error?.message || error, 300) })
      try {
        stems = await separateWithRvc(located.file, config, jobDir, python)
      } catch (fallbackError) {
        throw Object.assign(
          new Error(`${separationNote}；回退也失败：${brief(fallbackError?.message || fallbackError, 400)}`),
          { code: 'SEPARATE_FAILED' },
        )
      }
    }
  } else {
    stems = await separateWithRvc(located.file, config, jobDir, python)
  }
  report('separate.done', { engine: stems.engine, vocal: stems.vocal, instrumental: stems.instrumental })

  report('convert', { model: modelLabel, index: indexPath ? basename(indexPath) : '(none)' })
  const converted = join(jobDir, 'vocal_converted.wav')
  const convertArgs = join(jobDir, 'convert.args.json')
  await writeFile(convertArgs, JSON.stringify({
    rvcRoot: root,
    tempDir: join(jobDir, 'tmp'),
    input: stems.vocal,
    output: converted,
    model: modelPath,
    index: indexPath,
    f0Method: cover.f0Method || 'rmvpe',
    f0UpKey: f0UpKey === undefined || f0UpKey === null ? Number(cover.f0UpKey || 0) : Number(f0UpKey),
    indexRate: Number(cover.indexRate ?? 0.75),
    rmsMix: Number(cover.rmsMix ?? 0.25),
    protect: Number(cover.protect ?? 0.33),
  }))
  const convertRun = await run(python, [join(WORKER_DIR, 'rvc_convert.py'), convertArgs], {
    cwd: root,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 60 * 60 * 1000,
  })
  const convertResult = parseWorkerJson(convertRun.stdout)
  if (convertRun.code !== 0 || !convertResult?.ok || !existsSync(converted)) {
    throw Object.assign(new Error(`RVC 转换失败：${brief(convertResult?.error || convertRun.stderr || convertRun.stdout, 800)}`), {
      code: 'CONVERT_FAILED',
    })
  }
  report('convert.done', { durationSec: convertResult.durationSec })

  report('mix', {})
  const songName = basename(located.file, extname(located.file)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const outBase = `${songName}_翻唱_${modelLabel.replace(/[\\/:*?"<>|]/g, '_')}`
  const outWav = join(store.outDir(), `${outBase}_${uid('').slice(0, 6)}.wav`)
  const outMp3 = outWav.replace(/\.wav$/i, '.mp3')
  const mixArgs = join(jobDir, 'mix.args.json')
  await writeFile(mixArgs, JSON.stringify({
    ffmpeg: store.ffmpegPath(),
    tempDir: join(jobDir, 'tmp'),
    converted,
    instrumental: stems.instrumental,
    vocalSource: stems.vocal,
    outWav,
    outMp3,
    sampleRate: 44100,
    loudness: cover.loudness || 'I=-11.5:TP=-1.0:LRA=11',
  }))
  const mixRun = await run(python, [join(WORKER_DIR, 'mix.py'), mixArgs], {
    cwd: root,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 30 * 60 * 1000,
  })
  const mixResult = parseWorkerJson(mixRun.stdout)
  if (mixRun.code !== 0 || !mixResult?.ok || !existsSync(outWav)) {
    throw Object.assign(new Error(`混音失败：${brief(mixResult?.error || mixRun.stderr || mixRun.stdout, 800)}`), {
      code: 'MIX_FAILED',
    })
  }
  report('done', { outWav, outMp3 })

  return {
    song: located.file,
    songSource: located.source,
    candidates: located.candidates,
    model: modelLabel,
    modelPath,
    index: indexPath,
    separation: stems.engine,
    separationNote,
    vocal: stems.vocal,
    instrumental: stems.instrumental,
    outWav,
    outMp3: existsSync(outMp3) ? outMp3 : '',
    durationSec: mixResult.durationSec,
    elapsedMs: Date.now() - started,
    jobDir,
  }
}

/** Model / index inventory for the settings page and the list tool. */
export function listModels(store) {
  const models = store.listRvcModels()
  return {
    root: models.root,
    models: models.models,
    indexes: models.indexes,
    error: models.error,
    python: store.detectRvcPython(models.root),
    msstConfigured: Boolean(store.read().cover?.msstUrl),
  }
}

export { parseWorkerJson }
