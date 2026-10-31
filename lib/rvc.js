/**
 * RVC client with two interchangeable backends, both pure HTTP:
 *
 * - `gradio` — the RVC WebUI itself (Gradio 3.x). Models come from
 *   `/run/infer_refresh`, the index from `/run/infer_change_voice`, conversion
 *   from `/run/infer_convert` (audio in/out as base64). No second process.
 * - `api` — the optional `server/rvc-api.py` service (`/health`, `/models`,
 *   `/convert`, `/separate`), needed only for separation.
 *
 * Backend detection is automatic: `/health` → api, `/config` with
 * `infer_convert` → gradio.
 */
import { brief, fetchJson } from './util.js'

function baseUrl(store, field = 'rvcUrl') {
  const url = String(store.read().cover?.[field] || '').trim()
  if (!url) {
    throw Object.assign(
      new Error(`未配置 ${field === 'rvcUrl' ? 'RVC 地址' : '分离服务地址'}（设置 → 语音工坊 → 歌曲翻唱）`),
      { code: 'NO_RVC' },
    )
  }
  return url.replace(/\/$/, '')
}

const configCache = new Map()

async function gradioConfig(base) {
  if (configCache.has(base)) return configCache.get(base)
  const config = await fetchJson(`${base}/config`, { timeoutMs: 15000 })
  configCache.set(base, config)
  return config
}

function dependency(config, name) {
  return (config?.dependencies || []).find((dep) => dep?.api_name === name)
}

/** Which backend answers at `base`? */
export async function detectBackend(base) {
  try {
    const health = await fetchJson(`${base}/health`, { timeoutMs: 4000 })
    if (health && health.ok !== false) {
      return { style: 'api', base, detail: `RVC API · ${health.rvcRoot || ''} · ${health.models ?? '?'} 个模型` }
    }
  } catch {
    /* not the api server */
  }
  try {
    const config = await gradioConfig(base)
    if (dependency(config, 'infer_convert')) {
      return { style: 'gradio', base, config, detail: `RVC WebUI（Gradio ${config.version || ''}）· 无需附加服务` }
    }
    if (String(config?.version || '').startsWith('3.')) {
      return { style: 'gradio-other', base, config, detail: '这是一个 Gradio 应用，但没有 RVC 推理接口' }
    }
  } catch {
    /* not gradio either */
  }
  return { style: 'unknown', base, detail: '' }
}

export async function rvcHealth(store) {
  try {
    const base = baseUrl(store)
    const backend = await detectBackend(base)
    if (backend.style === 'unknown') return { ok: false, detail: '该地址既不是 RVC API，也不是可用的 RVC WebUI' }
    return { ok: backend.style === 'api' || backend.style === 'gradio', detail: backend.detail }
  } catch (error) {
    return { ok: false, detail: brief(error?.message || error, 300) }
  }
}

/** Post to a Gradio 3 `/run/{api_name}` endpoint. */
async function gradioRun(base, name, data, timeoutMs = 60 * 60 * 1000) {
  const response = await fetch(`${base}/run/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    const diagnosis = await maybeDiagnose(base)
    throw new Error(`RVC WebUI /run/${name} 失败：HTTP ${response.status} ${brief(text, 300)}${diagnosis ? ` · ${diagnosis}` : ''}`)
  }
  return text ? JSON.parse(text) : {}
}

async function maybeDiagnose(base) {
  try {
    const config = await gradioConfig(base)
    if (dependency(config, 'infer_convert')) {
      return '该地址是 RVC WebUI：换声接口可用，但它的分离接口是流式生成器且队列路由关闭，无法等待完成'
    }
  } catch {
    /* ignore */
  }
  return ''
}

/** Model inventory. `indexes` is only filled for the api backend. */
export async function rvcModels(store) {
  const base = baseUrl(store)
  const backend = await detectBackend(base)
  if (backend.style === 'api') {
    const body = await fetchJson(`${base}/models`, { timeoutMs: 20000 })
    return {
      style: 'api',
      rvcUrl: base,
      root: body?.rvcRoot || '',
      models: Array.isArray(body?.models) ? body.models : [],
      indexes: Array.isArray(body?.indexes) ? body.indexes : [],
      error: null,
    }
  }
  if (backend.style === 'gradio') {
    const result = await gradioRun(base, 'infer_refresh', [])
    const choices = result?.data?.[0]?.choices || []
    return {
      style: 'gradio',
      rvcUrl: base,
      root: '',
      models: choices.map((name) => ({ id: String(name), name: String(name).replace(/\.(pth|pt)$/i, ''), kind: 'webui' })),
      // Gradio only reveals the index after a model is loaded; the converter
      // resolves it on demand.
      indexes: [],
      error: null,
    }
  }
  const diagnosis = await maybeDiagnose(base)
  throw new Error(diagnosis || `该地址不是 RVC 服务：${base}`)
}

/** Ask the WebUI which index belongs to `model` (also loads the model). */
async function gradioChangeVoice(base, model) {
  const config = await gradioConfig(base)
  const dep = dependency(config, 'infer_change_voice')
  if (!dep) return { index: '', spkId: 0, protect: 0.33 }
  const components = Object.fromEntries((config.components || []).map((item) => [item.id, item]))
  const value = (id, fallback) => components[id]?.props?.value ?? fallback
  const data = [model, value(dep.inputs[1], 0.33), value(dep.inputs[2], 0.33)]
  const result = await gradioRun(base, 'infer_change_voice', data, 10 * 60 * 1000)
  return {
    index: result?.data?.[3]?.value || '',
    spkId: 0,
    protect: result?.data?.[1]?.value ?? 0.33,
  }
}

/** Download a Gradio-produced file by its server path. */
async function gradioAudioOut(base, path) {
  const url = `${base}/file=${encodeURIComponent(path)}`
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!response.ok) throw new Error(`下载 RVC 结果失败：HTTP ${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Convert a vocal and return the converted WAV bytes. */
export async function rvcConvert(store, { vocal, model, index, f0Method, f0UpKey, indexRate, rmsMix, protect }) {
  const base = baseUrl(store)
  const backend = await detectBackend(base)
  const shift = Number(f0UpKey ?? 0)
  const method = String(f0Method || 'rmvpe')

  if (backend.style === 'gradio') {
    if (!model) throw new Error('RVC WebUI 需要选择模型')
    const config = await gradioConfig(base)
    const dep = dependency(config, 'infer_convert')
    if (!dep) throw new Error('RVC WebUI 没有 infer_convert 接口')
    const components = Object.fromEntries((config.components || []).map((item) => [item.id, item]))
    const value = (id, fallback) => components[id]?.props?.value ?? fallback
    const changed = await gradioChangeVoice(base, model)
    const indexPath = index || changed.index
    const data = [
      changed.spkId,
      { name: 'vocal.wav', data: `data:audio/wav;base64,${Buffer.from(vocal).toString('base64')}` },
      shift,
      method,
      indexPath,
      Number(indexRate ?? 0.75),
      value(dep.inputs[6], 0),
      Number(rmsMix ?? 0.25),
      Number(protect ?? changed.protect ?? 0.33),
    ]
    const result = await gradioRun(base, 'infer_convert', data)
    const out = result?.data?.[1]
    const outPath = out?.name || out?.path
    if (!outPath) {
      const info = String(result?.data?.[0] || '')
      throw new Error(`RVC WebUI 没有返回音频：${brief(info, 300)}`)
    }
    return gradioAudioOut(base, outPath)
  }

  if (backend.style !== 'api') throw new Error((await maybeDiagnose(base)) || `该地址不是 RVC 服务：${base}`)

  const form = new FormData()
  form.append('file', new Blob([vocal], { type: 'audio/wav' }), 'vocal.wav')
  form.append('model', String(model || ''))
  form.append('index', String(index || ''))
  form.append('f0_method', method)
  form.append('f0_up_key', String(shift))
  form.append('index_rate', String(indexRate ?? 0.75))
  form.append('rms_mix', String(rmsMix ?? 0.25))
  form.append('protect', String(protect ?? 0.33))
  const response = await fetch(`${base}/convert`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60 * 60 * 1000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`RVC /convert 失败：HTTP ${response.status} ${brief(text, 400)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/** Separate using the api backend's /separate. */
async function apiSeparate(base, song, model) {
  const form = new FormData()
  form.append('file', new Blob([song], { type: 'audio/wav' }), 'song.wav')
  if (model) form.append('model', String(model))
  const response = await fetch(`${base}/separate`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60 * 60 * 1000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`RVC /separate 失败：HTTP ${response.status} ${brief(text, 400)}`)
  }
  const body = await response.json()
  if (!body?.vocal || !body?.instrumental) throw new Error('RVC /separate 没有返回双轨音频')
  return {
    vocal: Buffer.from(body.vocal, 'base64'),
    instrumental: Buffer.from(body.instrumental, 'base64'),
    engine: `RVC API · ${body.model || 'PyMSS'}`,
  }
}

/**
 * Vocal/instrumental separation.
 *
 * The RVC WebUI's separator is a Gradio streaming generator whose queue routes
 * are disabled in this build, so it cannot be driven to completion over HTTP;
 * separation therefore needs either MSST_WebUI (tried first by the caller) or
 * the api backend's /separate.
 */
export async function rvcSeparate(store, { song, model }) {
  const separateUrl = String(store.read().cover?.separateUrl || '').trim()
  if (separateUrl) {
    const base = separateUrl.replace(/\/$/, '')
    const backend = await detectBackend(base)
    if (backend.style === 'api') return apiSeparate(base, song, model)
    throw new Error(`分离服务地址不是 RVC API：${base}`)
  }
  const base = baseUrl(store)
  const backend = await detectBackend(base)
  if (backend.style === 'api') return apiSeparate(base, song, model)
  throw new Error(
    '人声分离需要 MSST_WebUI，或在 RVC 机器上运行 server/rvc-api.py 并填写「分离服务地址」。'
    + '（RVC WebUI 的分离是流式生成器，这个构建关闭了 Gradio 队列，插件无法等待它完成；'
    + '换声本身仍然直接用 WebUI，不需要该服务。）',
  )
}
