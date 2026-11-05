/**
 * Client for the independent `rvc-worker` service (see ../rvc-worker/API.md).
 *
 * The worker runs *on the RVC/MSST machine* and owns model loading, conversion,
 * separation and process control, so the cover pipeline keeps working when DSH
 * and RVC live on different hosts. Everything here is pure HTTP + file transfer.
 */
import { brief, fetchJson } from './util.js'

const WORKER_VERSION = 1

function workerConfig(store) {
  const cover = store.read().cover || {}
  const url = String(cover.workerUrl || '').trim().replace(/\/$/, '')
  if (!url) throw Object.assign(new Error('未配置 RVC Worker 地址（设置 → 语音工坊 → 歌曲翻唱）'), { code: 'NO_WORKER' })
  return { url, token: String(cover.workerToken || '').trim() }
}

function headers(token, extra = {}) {
  const result = { ...extra }
  if (token) result.Authorization = `Bearer ${token}`
  return result
}

async function workerFetch(store, path, options = {}) {
  const { url, token } = workerConfig(store)
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: headers(token, options.headers || {}),
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
  })
  return response
}

async function workerJson(store, path, options = {}) {
  const response = await workerFetch(store, path, options)
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try {
      message = JSON.parse(text)?.error?.message || text
    } catch {
      /* keep raw */
    }
    throw new Error(`rvc-worker ${path} HTTP ${response.status}：${brief(message, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

export async function workerHealth(store) {
  try {
    const body = await workerJson(store, '/v1/health', { timeoutMs: 4000 })
    return {
      ok: body?.ok !== false,
      detail: `rvc-worker ${body?.version || ''} · RVC ${body?.rvc?.available ? '可用' : '不可用'}`
        + ` · GPU ${body?.gpu?.name || '未知'} · 运行中任务 ${body?.jobs?.running ?? 0}`,
      raw: body,
    }
  } catch (error) {
    return { ok: false, detail: brief(error?.message || error, 300) }
  }
}

export async function workerModels(store) {
  const body = await workerJson(store, '/v1/models', { timeoutMs: 20000 })
  return {
    style: 'worker',
    root: body?.rvc?.root || body?.root || '',
    models: Array.isArray(body?.models) ? body.models : [],
    indexes: Array.isArray(body?.indexes) ? body.indexes : [],
    error: null,
  }
}

export async function workerConvert(store, { vocal, model, index, f0Method, f0UpKey, indexRate, rmsMix, protect }) {
  const form = new FormData()
  form.append('file', new Blob([vocal], { type: 'audio/wav' }), 'vocal.wav')
  form.append('model', String(model || ''))
  form.append('index', String(index || ''))
  form.append('f0_method', String(f0Method || 'rmvpe'))
  form.append('f0_up_key', String(f0UpKey ?? 0))
  form.append('index_rate', String(indexRate ?? 0.75))
  form.append('rms_mix', String(rmsMix ?? 0.25))
  form.append('protect', String(protect ?? 0.33))
  const response = await workerFetch(store, '/v1/convert', {
    method: 'POST',
    body: form,
    timeoutMs: 60 * 60 * 1000,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`rvc-worker /v1/convert HTTP ${response.status}：${brief(text, 300)}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

export async function workerDownload(store, fileId) {
  const response = await workerFetch(store, `/v1/files/${encodeURIComponent(fileId)}`, { timeoutMs: 10 * 60 * 1000 })
  if (!response.ok) throw new Error(`rvc-worker 下载 ${fileId} 失败：HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Ask the worker to separate a song; returns vocal/instrumental WAV bytes. */
export async function workerSeparate(store, { song, mode = 'vocals' }) {
  const form = new FormData()
  form.append('file', new Blob([song], { type: 'audio/wav' }), 'song.wav')
  form.append('mode', mode)
  const response = await workerFetch(store, '/v1/separate', {
    method: 'POST',
    body: form,
    timeoutMs: 60 * 60 * 1000,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`rvc-worker /v1/separate HTTP ${response.status}：${brief(text, 300)}`)
  }
  const body = await response.json()
  const vocal = body?.vocal || body?.vocalFileId
  const instrumental = body?.instrumental || body?.instrumentalFileId
  if (!vocal || !instrumental) throw new Error('rvc-worker 分离结果缺少 vocal/instrumental')
  return {
    vocal: await workerDownload(store, vocal),
    instrumental: await workerDownload(store, instrumental),
    engine: `rvc-worker · ${body?.model || mode}`,
  }
}

export async function workerProcesses(store) {
  return workerJson(store, '/v1/process', { timeoutMs: 5000 })
}

export async function workerProcessAction(store, name, action, body = {}) {
  return workerJson(store, `/v1/process/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 120000,
  })
}

export { WORKER_VERSION }
