/**
 * TTS provider adapters.
 *
 * Every adapter writes one audio file into the plugin's `out/` directory and
 * returns a small description of what happened. Failures carry an actionable
 * reason instead of a raw stack: this text is what the settings page shows and
 * what the agent tool returns.
 *
 * Local providers
 *   - indextts   Gradio app (IndexTTS 2.x webui), `/gradio_api/call/gen_single`
 *   - gptsovits  GPT-SoVITS `api_v2.py` HTTP server (default port 9880)
 * Online providers
 *   - siliconflow  POST /v1/audio/speech            → binary audio
 *   - minimax      POST /v1/t2a_v2                  → JSON, data.audio is hex
 *   - mimo         POST /v1/chat/completions + audio → JSON, base64 in message
 *   - openai       POST /v1/audio/speech            → binary audio
 */
import { createReadStream, existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { brief, fetchBytes, fetchJson, ensureDir, removeFile, uid } from './util.js'
import { toCosyPrefix, toMinimax, toMimoStyle, toVector } from './emotion.js'

export const PROVIDERS = {
  indextts: { label: 'IndexTTS（本地 Gradio）', kind: 'local', needsRef: true, supportsEmotion: 'vector', defaultFormat: 'wav' },
  gptsovits: { label: 'GPT-SoVITS（本地 api_v2）', kind: 'local', needsRef: true, supportsEmotion: 'none', defaultFormat: 'wav' },
  siliconflow: { label: '硅基流动 SiliconFlow', kind: 'online', needsRef: false, supportsEmotion: 'prompt', defaultFormat: 'wav' },
  minimax: { label: 'MiniMax', kind: 'online', needsRef: false, supportsEmotion: 'enum', defaultFormat: 'mp3' },
  mimo: { label: '小米 MiMo', kind: 'online', needsRef: false, supportsEmotion: 'prompt', defaultFormat: 'wav' },
  openai: { label: 'OpenAI 兼容 /v1/audio/speech', kind: 'online', needsRef: false, supportsEmotion: 'prompt', defaultFormat: 'mp3' },
}

function providerError(providerId, message, extra = {}) {
  return Object.assign(new Error(`[${providerId}] ${message}`), { provider: providerId, ...extra })
}

// ---------------------------------------------------------------------------
// Gradio helpers (IndexTTS and MSST both speak this protocol)
// ---------------------------------------------------------------------------

/** Upload one local file to a Gradio app; returns its server-side FileData dict. */
export async function gradioUpload(baseUrl, filePath) {
  const bytes = await readFile(filePath)
  const boundary = `----dsh${uid('').slice(0, 12)}`
  const name = basename(filePath)
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([head, bytes, tail])
  const attempts = [`${baseUrl}/gradio_api/upload`, `${baseUrl}/upload`]
  let lastError = null
  for (const url of attempts) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = new Error(`upload HTTP ${response.status}: ${brief(text, 200)}`)
        continue
      }
      const parsed = JSON.parse(text)
      const serverPath = Array.isArray(parsed) ? parsed[0] : parsed
      if (typeof serverPath === 'string' && serverPath) return { path: serverPath, meta: { _type: 'gradio.FileData' }, orig_name: name }
      lastError = new Error(`unexpected upload response: ${brief(text, 200)}`)
    } catch (error) {
      lastError = error
    }
  }
  throw providerError('gradio', `upload failed: ${brief(lastError?.message || lastError, 300)}`)
}

/** Call one named Gradio endpoint and wait for its `complete` event. */
export async function gradioCall(baseUrl, fnName, data, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const prefixes = [`${baseUrl}/gradio_api/call/${fnName}`, `${baseUrl}/call/${fnName}`]
  try {
    let lastError = null
    for (const prefix of prefixes) {
      try {
        const start = await fetch(prefix, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data }),
          signal: controller.signal,
        })
        const startText = await start.text()
        if (!start.ok) {
          lastError = new Error(`HTTP ${start.status}: ${brief(startText, 300)}`)
          continue
        }
        let eventId
        try {
          eventId = JSON.parse(startText).event_id
        } catch {
          lastError = new Error(`unexpected call response: ${brief(startText, 300)}`)
          continue
        }
        const stream = await fetch(`${prefix}/${eventId}`, { signal: controller.signal })
        const text = await stream.text()
        if (!stream.ok) throw new Error(`HTTP ${stream.status}: ${brief(text, 300)}`)
        let event = null
        let complete = null
        let failure = null
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trimEnd()
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) {
            const payload = line.slice(6)
            if (event === 'complete') {
              try {
                complete = JSON.parse(payload)
              } catch {
                complete = payload
              }
            } else if (event === 'error') {
              failure = payload
            }
          }
        }
        if (failure) throw new Error(`endpoint error: ${brief(failure, 400)}`)
        if (complete === null) throw new Error('no complete event received')
        return complete
      } catch (error) {
        lastError = error
      }
    }
    throw providerError('gradio', `call ${fnName} failed: ${brief(lastError?.message || lastError, 400)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Pull a path out of Gradio's several output shapes. */
export function gradioFilePath(result) {
  const first = Array.isArray(result) ? result[0] : result
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') {
    if (typeof first.value === 'string') return first.value
    if (typeof first.path === 'string') return first.path
    if (first.value && typeof first.value === 'object' && typeof first.value.path === 'string') return first.value.path
    if (Array.isArray(first.value) && typeof first.value[0] === 'string') return first.value[0]
  }
  return ''
}

/** Gradio may hand back a server path (same machine) or need a download. */
export async function fetchGradioFile(baseUrl, serverPath, destFile) {
  if (serverPath && existsSync(serverPath)) {
    await writeFile(destFile, await readFile(serverPath))
    return destFile
  }
  const url = `${baseUrl.replace(/\/$/, '')}/gradio_api/file=${encodeURIComponent(serverPath)}`
  const { bytes } = await fetchBytes(url)
  await writeFile(destFile, bytes)
  return destFile
}

// ---------------------------------------------------------------------------
// Local providers
// ---------------------------------------------------------------------------

const INDEX_EMO_SAME = '与音色参考音频相同'
const INDEX_EMO_VECTOR = '使用情感向量控制'

async function synthesizeIndexTts({ baseUrl, text, refPath, cfg, emotion, outFile, lang }) {
  const fileData = await gradioUpload(baseUrl, refPath)
  const vector = toVector(emotion)
  const useVector = vector.some((value) => value > 0)
  const data = [
    useVector ? INDEX_EMO_VECTOR : INDEX_EMO_SAME, // 情感控制方式
    fileData, // 音色参考音频
    text, // 目标文本
    lang || cfg.lang || 'ZH', // 语言
    null, // 情感参考音频
    Number(cfg.emoWeight ?? 0.8), // 情感权重
    ...vector, // 喜 怒 哀 惧 厌恶 低落 惊喜 平静
    '', // 情感描述文本
    false, // 情感随机采样
    120, // 分句最大 token
    Number(cfg.durationFactor ?? 1), // 时长系数
    true, // do_sample
    0.8, // top_p
    30, // top_k
    0.8, // temperature
    0.0, // length_penalty
    3, // num_beams
    10.0, // repetition_penalty
    1500, // max_mel_tokens
  ]
  const result = await gradioCall(baseUrl, 'gen_single', data)
  const serverPath = gradioFilePath(result)
  if (!serverPath) throw providerError('indextts', `no audio returned: ${brief(JSON.stringify(result), 300)}`)
  await fetchGradioFile(baseUrl, serverPath, outFile)
  return { emotionApplied: useVector }
}

async function synthesizeGptSoVits({ baseUrl, text, refPath, cfg, emotion, outFile, speed }) {
  const params = new URLSearchParams({
    text,
    text_lang: cfg.textLang || 'zh',
    ref_audio_path: refPath,
    prompt_text: cfg.promptText || '',
    prompt_lang: cfg.promptLang || 'zh',
    top_k: '5',
    top_p: '1',
    temperature: '1',
    text_split_method: 'cut5',
    batch_size: '1',
    speed_factor: String(speed || cfg.speed || 1),
    ref_free: cfg.promptText ? 'false' : 'true',
    media_type: 'wav',
    streaming_mode: 'false',
  })
  let bytes
  try {
    const result = await fetchBytes(`${baseUrl.replace(/\/$/, '')}/tts?${params.toString()}`, { timeoutMs: 300000 })
    bytes = result.bytes
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) {
      const result = await fetchBytes(`${baseUrl.replace(/\/$/, '')}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(params)),
        timeoutMs: 300000,
      })
      bytes = result.bytes
    } else {
      throw providerError(
        'gptsovits',
        `请求失败（${brief(error?.message || error, 200)}）。GPT-SoVITS 的 WebUI 端口没有 TTS API，` +
          '请先启动 api_v2.py（默认 9880 端口），并让 baseUrl 指向它。',
      )
    }
  }
  await writeFile(outFile, bytes)
  return { emotionApplied: false }
}

// ---------------------------------------------------------------------------
// Online providers
// ---------------------------------------------------------------------------

async function synthesizeSiliconflow({ cfg, text, outFile, emotion, speed }) {
  const apiKey = cfg.apiKey
  if (!apiKey) throw providerError('siliconflow', 'apiKey 未配置')
  const prefix = toCosyPrefix(emotion)
  const input = prefix ? `${prefix} ${text}` : text
  const body = {
    model: cfg.model || 'FunAudioLLM/CosyVoice2-0.5B',
    input,
    voice: cfg.voice || '',
    response_format: cfg.format || 'wav',
    speed: Number(speed || cfg.speed || 1),
  }
  const { bytes } = await fetchBytes(`${cfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 180000,
  })
  await writeFile(outFile, bytes)
  return { emotionApplied: Boolean(prefix) }
}

async function synthesizeMinimax({ cfg, text, outFile, emotion, speed }) {
  const apiKey = cfg.apiKey
  if (!apiKey) throw providerError('minimax', 'apiKey 未配置')
  const format = cfg.format || 'mp3'
  const body = {
    model: cfg.model || 'speech-2.8-hd',
    text,
    stream: false,
    voice_setting: {
      voice_id: cfg.voice || 'female-shaonv',
      speed: Number(speed || cfg.speed || 1),
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      format,
      sample_rate: 32000,
      bitrate: 128000,
      channel: 1,
    },
    output_format: 'hex',
  }
  const emotionEnum = toMinimax(emotion)
  if (emotionEnum) body.voice_setting.emotion = emotionEnum
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, '')}/t2a_v2`)
  if (cfg.groupId) url.searchParams.set('GroupId', cfg.groupId)
  const result = await fetchJson(url.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 180000,
  })
  const statusCode = result?.base_resp?.status_code
  if (statusCode !== undefined && Number(statusCode) !== 0) {
    throw providerError('minimax', `base_resp.status_code=${statusCode}: ${brief(result?.base_resp?.status_msg || '', 200)}`)
  }
  const audio = result?.data?.audio
  if (!audio) throw providerError('minimax', `响应里没有 data.audio：${brief(JSON.stringify(result), 300)}`)
  if (/^https?:\/\//i.test(audio)) {
    const { bytes } = await fetchBytes(audio)
    await writeFile(outFile, bytes)
  } else if (/^[0-9a-fA-F]+$/.test(audio)) {
    await writeFile(outFile, Buffer.from(audio, 'hex'))
  } else {
    await writeFile(outFile, Buffer.from(audio, 'base64'))
  }
  return { emotionApplied: Boolean(emotionEnum) }
}

async function synthesizeMimo({ cfg, text, outFile, emotion, speed }) {
  const apiKey = cfg.apiKey
  if (!apiKey) throw providerError('mimo', 'apiKey 未配置')
  const style = toMimoStyle(emotion) || cfg.style || ''
  const messages = []
  if (style) messages.push({ role: 'user', content: style })
  messages.push({ role: 'assistant', content: text })
  const body = {
    model: cfg.model || 'mimo-v2.5-tts',
    messages,
    audio: { format: cfg.format || 'wav', voice: cfg.voice || '' },
  }
  if (speed && Number(speed) !== 1) body.audio.speed = Number(speed)
  const result = await fetchJson(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': apiKey, authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 180000,
  })
  const audio = result?.choices?.[0]?.message?.audio?.data
  if (!audio) throw providerError('mimo', `响应里没有 choices[0].message.audio.data：${brief(JSON.stringify(result), 300)}`)
  await writeFile(outFile, Buffer.from(audio, 'base64'))
  return { emotionApplied: Boolean(style) }
}

async function synthesizeOpenAi({ cfg, text, outFile, emotion, speed }) {
  const apiKey = cfg.apiKey
  if (!apiKey) throw providerError('openai', 'apiKey 未配置')
  const body = {
    model: cfg.model || 'gpt-4o-mini-tts',
    input: text,
    voice: cfg.voice || 'alloy',
    response_format: cfg.format || 'mp3',
    speed: Number(speed || cfg.speed || 1),
  }
  const instruction = cfg.emotionInstructions === false ? '' : toCosyPrefix(emotion).replace(' <|endofprompt|>', '')
  if (instruction) body.instructions = instruction
  const { bytes } = await fetchBytes(`${cfg.baseUrl.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 180000,
  })
  await writeFile(outFile, bytes)
  return { emotionApplied: Boolean(instruction) }
}

const ADAPTERS = {
  indextts: synthesizeIndexTts,
  gptsovits: synthesizeGptSoVits,
  siliconflow: synthesizeSiliconflow,
  minimax: synthesizeMinimax,
  mimo: synthesizeMimo,
  openai: synthesizeOpenAi,
}

/**
 * Resolve everything one synthesis needs, then hand it to the adapter.
 *
 * @param {object} options
 * @param {import('./store.js').Store} options.store
 * @param {string} options.text
 * @param {string} [options.providerId] defaults to the configured provider
 * @param {string} [options.voiceId] reference voice id/name (local providers)
 * @param {{label: string, intensity: number, source: string}} [options.emotion]
 * @param {number} [options.speed]
 * @param {string} [options.lang]
 */
export async function synthesize({ store, text, providerId, voiceId, emotion, speed, lang }) {
  const config = store.read()
  const id = String(providerId || config.tts.provider || 'indextts')
  const adapter = ADAPTERS[id]
  if (!adapter) throw providerError(id, `未知的提供商，可选：${Object.keys(ADAPTERS).join(', ')}`)
  const meta = PROVIDERS[id]
  const cfg = config.tts.providers?.[id] ?? {}
  if (!cfg.baseUrl) throw providerError(id, 'baseUrl 未配置（设置 → 语音工坊）')

  const body = String(text ?? '').trim()
  if (!body) throw providerError(id, 'text 为空')

  let refPath = null
  let usedVoice = null
  if (meta.needsRef) {
    const wanted = voiceId || cfg.refAudioId
    usedVoice = store.voiceByIdOrName(wanted)
    if (!usedVoice && !wanted) {
      // No default configured: the first available voice is the obvious
      // intent, and prompting the user first would block every agent call.
      const first = store.listVoices().find((voice) => voice.available)
      if (first) usedVoice = first
    }
    if (!usedVoice) {
      throw providerError(id, `本地提供商需要参考音频：请先在设置页选择或上传一个音色${wanted ? `（找不到 ${wanted}）` : ''}`)
    }
    refPath = store.voicePath(usedVoice.id)
    if (!refPath) throw providerError(id, `参考音频文件缺失：${usedVoice.name}`)
  }

  const format = (cfg.format || meta.defaultFormat || 'wav').toLowerCase()
  const outFile = join(store.dir, 'out', `${uid('tts_')}.${format}`)
  ensureDir(join(store.dir, 'out'))

  const started = Date.now()
  let result
  try {
    result = await adapter({ baseUrl: cfg.baseUrl, text: body, refPath, cfg, emotion, outFile, speed, lang })
  } catch (error) {
    await removeFile(outFile)
    throw error
  }
  const bytes = existsSync(outFile) ? (await import('node:fs')).statSync(outFile).size : 0
  if (bytes === 0) {
    await removeFile(outFile)
    throw providerError(id, '提供商返回了空音频')
  }
  return {
    file: outFile,
    provider: id,
    providerLabel: meta.label,
    format,
    voice: refPath ? usedVoice?.name ?? '' : cfg.voice || '',
    emotion: emotion ? `${emotion.label}(${emotion.intensity.toFixed(2)})` : 'neutral',
    emotionApplied: Boolean(result?.emotionApplied),
    bytes,
    elapsedMs: Date.now() - started,
  }
}
