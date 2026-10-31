/**
 * Song-cover pipeline: locate the song → separate → RVC (over HTTP) → mix.
 *
 * RVC is addressed only by URL (`cover.rvcUrl`), never by filesystem path, so
 * the cover feature keeps working when RVC runs on another machine — the same
 * way IndexTTS is addressed. Separation comes from either MSST_WebUI (when
 * configured and local) or the RVC server's own /separate endpoint (PyMSS);
 * mixing happens locally in plain Node (lib/wav.js).
 *
 * The song argument is a local audio path: music-folder matching and link
 * downloading were removed on purpose, the caller names the file it wants.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { brief, ensureDir, fetchJson, uid } from './util.js'
import { decodeWav, encodeWav24, ffmpeg, mixCover } from './wav.js'
import { rvcConvert, rvcModels, rvcSeparate } from './rvc.js'
import { gradioCall, gradioUpload } from './tts.js'

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.aiff', '.wma'])

function isAudio(path) {
  return AUDIO_EXT.has(extname(String(path)).toLowerCase())
}

/** Resolve a cover request to one local audio file (path only). */
export function resolveSong(input) {
  const wanted = String(input || '').trim()
  if (!wanted) throw Object.assign(new Error('song is required'), { code: 'BAD_SONG' })
  if (!existsSync(wanted)) {
    throw Object.assign(
      new Error(`找不到歌曲文件：${wanted}（请提供本机绝对路径，例如 D:\\music\\song.wav）`),
      { code: 'SONG_NOT_FOUND' },
    )
  }
  if (!isAudio(wanted)) {
    throw Object.assign(new Error(`不支持的音频格式：${extname(wanted) || '(无扩展名)'}`), { code: 'BAD_SONG' })
  }
  return { file: wanted, source: 'path' }
}

/** MSST_WebUI separation — only usable when its output directory is on this machine. */
async function separateWithMsst(song, msstUrl, tmpDir) {
  const base = msstUrl.replace(/\/$/, '')
  const info = await fetchJson(`${base}/info`, { timeoutMs: 15000 })
  const params = info?.named_endpoints?.['/run_inference_single']?.parameters || []
  const byName = Object.fromEntries(params.map((param) => [param.parameter_name, param]))
  const model = byName.selected_model?.parameter_default
  if (!model) throw new Error('MSST_WebUI 没有可用的分离模型')
  const gpu = byName.gpu_id?.parameter_default
  const storeDir = ensureDir(join(tmpDir, 'msst'))
  const fileData = await gradioUpload(base, song)
  await gradioCall(base, 'run_inference_single', [
    model,
    [fileData],
    storeDir,
    ['dry'],
    Array.isArray(gpu) && gpu.length ? gpu : [],
    'wav',
    false,
    false,
  ], { timeoutMs: 30 * 60 * 1000 })

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
  if (!vocal || !instrumental) throw new Error('MSST 输出里没有同时找到人声与伴奏（远端 MSST 或模型不含双轨）')
  return { vocal: readFileSync(vocal), instrumental: readFileSync(instrumental), engine: 'MSST_WebUI' }
}

/** Separate with MSST when configured, else with the RVC server's PyMSS. */
async function separate(store, songPath, tmpDir) {
  const config = store.read()
  const notes = []
  if (config.cover?.msstUrl) {
    try {
      return await separateWithMsst(songPath, config.cover.msstUrl, tmpDir)
    } catch (error) {
      notes.push(`MSST 失败（${brief(error?.message || error, 200)}）`)
    }
  }
  try {
    const result = await rvcSeparate(store, { song: readFileSync(songPath) })
    const engine = result.engine.startsWith('RVC API') ? result.engine : `RVC API · ${result.engine}`
    return { ...result, engine }
  } catch (error) {
    notes.push(`RVC /separate 失败（${brief(error?.message || error, 300)}）`)
    throw Object.assign(new Error(`人声分离失败：${notes.join('；')}`), { code: 'SEPARATE_FAILED' })
  }
}

/** Model/index inventory from the RVC API. */
export async function listModels(store) {
  const url = String(store.read().cover?.rvcUrl || '').trim()
  if (!url) return { style: '', root: '', models: [], indexes: [], error: '未配置 RVC 地址', rvcUrl: '' }
  try {
    const result = await rvcModels(store)
    return { ...result, error: null, rvcUrl: url }
  } catch (error) {
    return { style: '', root: '', models: [], indexes: [], error: brief(error?.message || error, 400), rvcUrl: url }
  }
}

/** Pick the index that belongs to a model, preferring the "added" variant. */
export function autoIndexFor(modelId, indexes) {
  const stem = String(modelId || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.pth$/i, '')
    .replace(/_e\d+_s\d+$/i, '')
  if (!stem) return ''
  const candidates = (indexes || []).filter(
    (index) => !/trained/i.test(index.name) && index.name.toLowerCase().includes(stem.toLowerCase()),
  )
  const preferred = candidates.find((index) => /added/i.test(index.name))
  return (preferred || candidates[0])?.path || ''
}

/** Local mastering: loudness + MP3, both optional (ffmpeg may be absent). */
async function master(store, wavPath, outWav, outMp3) {
  const config = store.read()
  const bin = String(config.cover?.ffmpegPath || '').trim() || 'ffmpeg'
  const loudness = String(config.cover?.loudness || 'I=-11.5:TP=-1.0:LRA=11')
  const mastered = wavPath.replace(/\.wav$/i, '.master.wav')
  const okLoud = await ffmpeg(bin, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-af', `loudnorm=${loudness}`,
    '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s24le', mastered,
  ])
  if (okLoud) {
    try {
      await writeFile(outWav, readFileSync(mastered))
    } catch {
      /* keep the unmixed-loudness file */
    }
  }
  let mp3 = ''
  if (outMp3) {
    const okMp3 = await ffmpeg(bin, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', okLoud ? mastered : wavPath,
      '-c:a', 'libmp3lame', '-b:a', '320k', outMp3,
    ])
    if (okMp3) mp3 = outMp3
  }
  return { mastered: okLoud, mp3 }
}

/**
 * Run a full cover.
 *
 * @param {object} options
 * @param {import('./store.js').Store} options.store
 * @param {string} options.song        local audio path
 * @param {string} [options.model]     RVC model id from the API
 * @param {string} [options.index]     index path; '' = auto-resolve
 * @param {number} [options.f0UpKey]   semitone shift
 * @param {(stage: string, detail?: object) => void} [options.onProgress]
 */
export async function makeCover({ store, song, model, index, f0UpKey, onProgress }) {
  const cover = store.read().cover || {}
  const report = (stage, detail = {}) => {
    try {
      onProgress?.(stage, detail)
    } catch {
      /* progress must never break the work */
    }
  }

  if (!String(cover.rvcUrl || '').trim()) {
    throw Object.assign(new Error('未配置 RVC API 地址（设置 → 语音工坊 → 歌曲翻唱）'), { code: 'NO_RVC' })
  }

  report('locate', { song })
  const located = resolveSong(song)
  report('locate.done', { file: located.file })

  const jobDir = ensureDir(join(store.tmpRoot(), uid('cover_')))
  const started = Date.now()

  report('separate', { engine: cover.msstUrl ? 'MSST_WebUI' : 'RVC API /separate' })
  const stems = await separate(store, located.file, jobDir)
  report('separate.done', { engine: stems.engine })

  const inventory = await listModels(store)
  let modelLabel = ''
  let modelId = ''
  const wanted = String(model || cover.model || '').trim()
  if (wanted) {
    const found = inventory.models.find((item) => item.id === wanted || item.name === wanted || item.path === wanted)
    if (!found) throw Object.assign(new Error(`RVC 模型不存在：${wanted}`), { code: 'MODEL_NOT_FOUND' })
    modelLabel = found.name || found.id
    modelId = found.id
  } else if (inventory.models.length > 0) {
    modelLabel = inventory.models[0].name || inventory.models[0].id
    modelId = inventory.models[0].id
  } else {
    throw Object.assign(new Error(`RVC API 没有可用模型：${inventory.error || 'assets/weights 为空'}`), { code: 'NO_MODEL' })
  }
  let indexPath = index ? String(index) : ''
  if (!indexPath && inventory.indexes.length > 0) indexPath = autoIndexFor(modelId, inventory.indexes)
  // Gradio backend: the WebUI resolves the index for the chosen model itself.

  report('convert', {
    model: modelLabel,
    index: indexPath ? basename(indexPath) : inventory.style === 'gradio' ? '(WebUI 自动匹配)' : '(none)',
  })
  const converted = await rvcConvert(store, {
    vocal: stems.vocal,
    model: modelId,
    index: indexPath,
    f0Method: cover.f0Method || 'rmvpe',
    f0UpKey: f0UpKey === undefined || f0UpKey === null ? Number(cover.f0UpKey || 0) : Number(f0UpKey),
    indexRate: Number(cover.indexRate ?? 0.75),
    rmsMix: Number(cover.rmsMix ?? 0.25),
    protect: Number(cover.protect ?? 0.33),
  })
  report('convert.done', { bytes: converted.length })

  report('mix', {})
  let mixed
  try {
    mixed = mixCover({
      instrumental: decodeWav(stems.instrumental),
      vocal: decodeWav(converted),
      vocalSource: decodeWav(stems.vocal),
    })
  } catch (error) {
    throw Object.assign(new Error(`混音失败：${brief(error?.message || error, 400)}`), { code: 'MIX_FAILED' })
  }
  const songName = basename(located.file, extname(located.file)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const outBase = `${songName}_翻唱_${modelLabel.replace(/[\\/:*?"<>|]/g, '_')}`
  const outWav = join(store.outDir(), `${outBase}_${uid('').slice(0, 6)}.wav`)
  const outMp3 = outWav.replace(/\.wav$/i, '.mp3')
  await writeFile(outWav, encodeWav24(mixed.sampleRate, mixed.channels, mixed.samples))
  const mastering = await master(store, outWav, outWav, outMp3)
  report('done', { outWav, outMp3: mastering.mp3 })

  return {
    song: located.file,
    songSource: 'path',
    model: modelLabel,
    modelPath: modelId,
    index: indexPath,
    separation: stems.engine,
    backend: inventory.style || 'api',
    separationNote: '',
    outWav,
    outMp3: mastering.mp3,
    durationSec: Math.round((mixed.samples.length / mixed.channels / mixed.sampleRate) * 100) / 100,
    elapsedMs: Date.now() - started,
    jobDir,
    loudnessApplied: mastering.mastered,
  }
}
