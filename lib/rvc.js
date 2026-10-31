/**
 * HTTP client for the RVC API server (server/rvc-api.py).
 *
 * RVC is intentionally *not* addressed by filesystem path: the plugin only ever
 * talks to a URL, exactly like IndexTTS. That keeps the cover pipeline working
 * when RVC runs on another machine.
 *
 * Contract:
 *   GET  {base}/health   → { ok, rvcRoot, models }
 *   GET  {base}/models   → { models: [{id,name,kind}], indexes: [{id,name,path}] }
 *   POST {base}/convert  → multipart(file, model, index, f0_method, f0_up_key,
 *                          index_rate, rms_mix, protect) → audio/wav
 *   POST {base}/separate → multipart(file) → { vocal: base64, instrumental: base64 }
 */
import { brief, fetchJson } from './util.js'

function baseUrl(store) {
  const url = String(store.read().cover?.rvcUrl || '').trim()
  if (!url) throw Object.assign(new Error('未配置 RVC API 地址（设置 → 语音工坊 → 歌曲翻唱）'), { code: 'NO_RVC' })
  return url.replace(/\/$/, '')
}

export async function rvcHealth(store, timeoutMs = 5000) {
  try {
    const body = await fetchJson(`${baseUrl(store)}/health`, { timeoutMs })
    return { ok: body?.ok !== false, detail: `RVC API · ${body?.rvcRoot || ''} · ${body?.models ?? '?'} 个模型` }
  } catch (error) {
    return { ok: false, detail: brief(error?.message || error, 300) }
  }
}

/**
 * Explain the common mistake of pointing at the RVC *WebUI* (a Gradio app that
 * has /config with infer_convert) instead of the RVC API server.
 */
async function diagnoseWrongService(store) {
  try {
    const config = await fetchJson(`${baseUrl(store)}/config`, { timeoutMs: 5000 })
    const apiNames = (config?.dependencies || []).map((dep) => dep?.api_name).filter(Boolean)
    if (apiNames.includes('infer_convert')) {
      return (
        "该地址是 RVC 的 Gradio WebUI（检测到 infer_convert 接口），不是 RVC API 服务。"
        + ' 请在 RVC 机器上运行插件自带的 server/rvc-api.py（默认端口 7866），再把地址改成那个端口；'
        + ' WebUI 可以继续开着用。'
      )
    }
    if (String(config?.version || '').startsWith('3.')) return '该端口是一个 Gradio 应用，但不是 RVC API 服务。'
  } catch {
    /* not even a Gradio app */
  }
  return ''
}

export async function rvcModels(store) {
  let body
  try {
    body = await fetchJson(`${baseUrl(store)}/models`, { timeoutMs: 20000 })
  } catch (error) {
    const diagnosis = await diagnoseWrongService(store)
    if (diagnosis) throw new Error(`${diagnosis}（原始错误：${brief(error?.message || error, 200)}）`)
    throw error
  }
  return {
    models: Array.isArray(body?.models) ? body.models : [],
    indexes: Array.isArray(body?.indexes) ? body.indexes : [],
    root: body?.rvcRoot || '',
  }
}

/** Upload a vocal and get the converted WAV back. */
export async function rvcConvert(store, { vocal, model, index, f0Method, f0UpKey, indexRate, rmsMix, protect }) {
  const form = new FormData()
  form.append('file', new Blob([vocal], { type: 'audio/wav' }), 'vocal.wav')
  form.append('model', String(model || ''))
  form.append('index', String(index || ''))
  form.append('f0_method', String(f0Method || 'rmvpe'))
  form.append('f0_up_key', String(f0UpKey ?? 0))
  form.append('index_rate', String(indexRate ?? 0.75))
  form.append('rms_mix', String(rmsMix ?? 0.25))
  form.append('protect', String(protect ?? 0.33))
  const response = await fetch(`${baseUrl(store)}/convert`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60 * 60 * 1000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const diagnosis = response.status === 404 ? await diagnoseWrongService(store) : ''
    throw new Error(`RVC /convert 失败：HTTP ${response.status} ${brief(text, 400)}${diagnosis ? ` · ${diagnosis}` : ''}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/** Vocal/instrumental separation on the RVC host (PyMSS models). */
export async function rvcSeparate(store, { song, model }) {
  const form = new FormData()
  form.append('file', new Blob([song], { type: 'audio/wav' }), 'song.wav')
  if (model) form.append('model', String(model))
  const response = await fetch(`${baseUrl(store)}/separate`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60 * 60 * 1000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const diagnosis = response.status === 404 ? await diagnoseWrongService(store) : ''
    throw new Error(`RVC /separate 失败：HTTP ${response.status} ${brief(text, 400)}${diagnosis ? ` · ${diagnosis}` : ''}`)
  }
  const body = await response.json()
  if (!body?.vocal || !body?.instrumental) throw new Error('RVC /separate 没有返回双轨音频')
  return {
    vocal: Buffer.from(body.vocal, 'base64'),
    instrumental: Buffer.from(body.instrumental, 'base64'),
    engine: `RVC API · ${body.model || 'PyMSS'}`,
  }
}
