/**
 * dsh-plugin-voice-studio — Host half.
 *
 * Owns three things the browser half and the agent tools both call:
 *   - the settings file (~/.dsh-voice-studio/config.json) and the reference
 *     voice library copied under ~/.dsh-voice-studio/refs;
 *   - the TTS providers (local IndexTTS / GPT-SoVITS, online SiliconFlow /
 *     MiniMax / MiMo / OpenAI-compatible);
 *   - the RVC cover pipeline and the optional QQ delivery.
 *
 * The browser half reads and writes it through the same-origin routes below;
 * the agent sees the same operations as tools. No operation exists only in one
 * of the two places.
 */
import { existsSync } from 'node:fs'
import { basename, join, normalize as normalizePath } from 'node:path'

import { listModels, makeCover } from './lib/cover.js'
import { describeEmotion, resolveEmotion } from './lib/emotion.js'
import { bridgeLinkInfo, bridgeVoiceInfo, enableBridgeVoice, qqStatus, sendToQq, setBridgeDshUrl } from './lib/qq.js'
import { Store } from './lib/store.js'
import { PROVIDERS, synthesize } from './lib/tts.js'
import { brief, probe, readJson, sendJson, streamFile, uid } from './lib/util.js'

import { appendFileSync } from 'node:fs'

// Boot diagnostics. The Host has no console this plugin can read back, so a
// failed activation would otherwise be invisible; failures are appended to
// boot.log next to config.json. Diagnostics never break activation.
function diag(message) {
  try {
    appendFileSync(join(new Store().dir, 'boot.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* ignore */
  }
}


/**
 * System-prompt guidance for QQ sessions. Registered as a prompt section (the
 * documented way to add text); it stays silent outside sessions where the
 * voice tools are visible.
 */
const VOICE_STUDIO_PROMPT_TEXT = [
  '【语音工坊 / Voice Studio】本机已安装，负责“说话”和“唱歌”。',
  '在 QQ 会话里，用户要求「发语音 / 用语音说 / 朗读 / 用某音色说话 / 以后都用语音」时：直接调用 voice_generate，并传 send_to_qq: true 以及唤醒提示里的 qq_key、qq_token。它会现场合成、自动放进 qq-bridge 的语音库并直接发出。',
  '重要：不要先用 qq_list_voices 判断能不能发语音——语音库通常是空的，voice_generate 会现场生成并入库。只有当 voice_generate 返回的 reason 说明缺少 key/token、或 bridge 语音开关未开时，才把那段原因如实转告用户。',
  '用户要求唱歌 / 翻唱时：song_cover(song, send_to_qq: true, qq_key, qq_token)。唱歌只在用户明确要求时发生，永远不走随机。',
  '随机语音：开关开启时，每次准备回复前可调用 voice_random_check；返回 voice: true 且这条回复适合朗读（短、无代码/列表/链接）时，改用 voice_generate 发语音代替文字。',
].join('\n')

const BASE = '/tts-studio'
const MAX_UPLOAD = 64 * 1024 * 1024

class VoiceStudio {
  constructor(ctx) {
    this.ctx = ctx
    this.store = new Store()
    this.ready = this.store.load()
    this.jobs = new Map()
  }

  async state() {
    await this.ready
    const config = this.store.read()
    const models = listModels(this.store)
    const bridge = bridgeVoiceInfo(this.store)
    const origin = this.origin()
    const link = bridgeLinkInfo(this.store)
    const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase()
    const sameOrigin = !link?.dshBaseUrl ? null : normalizeOrigin(link.dshBaseUrl) === normalizeOrigin(origin)
    const portMatch = /:(\d+)\s*$/.exec(origin)
    return {
      ok: true,
      settings: config,
      voices: this.store.listVoices(),
      providers: PROVIDERS,
      models,
      dsh: {
        origin,
        port: portMatch ? portMatch[1] : '',
      },
      bridge: {
        ...bridge,
        dshBaseUrl: link?.dshBaseUrl || '',
        dshModel: link?.dshModel || '',
        dshMatch: sameOrigin,
      },
      autoVoice: config.autoVoice,
      capabilities: {
        emotion: this.emotionCapabilities(),
        qq: {
          adapter: config.qq?.mode || 'bridge',
          bridgeAvailable: bridge.available,
          bridgeSwitch: bridge.enabled === true,
          bridgeTool: bridge.toolEnabled === true,
          mode: config.qq?.mode || 'bridge',
          enabled: Boolean(config.qq?.enabled),
        },
      },
      paths: {
        dataDir: this.store.dir,
        outDir: join(this.store.dir, 'out'),
      },
    }
  }

  /** The origin this DSH process serves (host:port changes on every launch). */
  origin() {
    try {
      return String(this.ctx.webServer?.getOrigin?.() || '')
    } catch {
      return ''
    }
  }

  /** Which emotion sources this Host can actually reach. */
  emotionCapabilities() {
    const found = []
    for (const candidate of ['emotion', 'emotions', 'sentiment', 'affect']) {
      let service
      try {
        service = this.ctx.get?.(candidate)
      } catch {
        service = undefined
      }
      if (!service) continue
      const methods = ['classify', 'detect', 'analyze', 'analyse', 'infer'].filter(
        (method) => typeof service[method] === 'function',
      )
      if (methods.length > 0) found.push({ name: candidate, methods })
    }
    const tools = []
    try {
      if (this.ctx.tools?.get?.('get_mood')) tools.push('get_mood')
    } catch {
      /* tools service unavailable */
    }
    return { dsh: found, dshTools: tools, lexicon: true }
  }

  async saveSettings(body) {
    await this.ready
    if (body && typeof body === 'object' && body.section) {
      await this.store.saveSection(String(body.section), body.patch ?? {})
    } else {
      await this.store.replace(body?.patch ?? body ?? {})
    }
    return this.store.read()
  }

  async addVoice(body) {
    await this.ready
    const mode = ['ask', 'add', 'replace'].includes(body?.mode) ? body.mode : 'ask'
    let buffer
    if (typeof body?.base64 === 'string' && body.base64) {
      const raw = body.base64.includes(',') ? body.base64.slice(body.base64.indexOf(',') + 1) : body.base64
      buffer = Buffer.from(raw, 'base64')
      if (buffer.length > MAX_UPLOAD) throw Object.assign(new Error('参考音频过大（>64MB）'), { code: 'TOO_LARGE' })
    }
    return this.store.addVoice({
      buffer,
      sourcePath: body?.sourcePath ? String(body.sourcePath) : undefined,
      name: body?.name ? String(body.name) : undefined,
      originalFile: body?.fileName ? String(body.fileName) : buffer ? 'upload.wav' : undefined,
      mode,
      replaceId: body?.replaceId ? String(body.replaceId) : undefined,
    })
  }

  async generate(body) {
    await this.ready
    const config = this.store.read()
    const text = String(body?.text ?? '')
    const mode = config.emotion?.mode || 'auto'
    const emotion = await resolveEmotion(this.ctx, text, body?.emotion, mode)
    const result = await synthesize({
      store: this.store,
      text,
      providerId: body?.provider ? String(body.provider) : undefined,
      voiceId: body?.voiceId ? String(body.voiceId) : undefined,
      emotion,
      speed: body?.speed === undefined ? undefined : Number(body.speed),
      lang: body?.lang ? String(body.lang) : undefined,
    })
    let delivery = { sent: false, reason: '未请求发送' }
    if (body?.sendToQQ) {
      delivery = await sendToQq({
        ctx: this.ctx,
        store: this.store,
        file: result.file,
        text: body?.caption ? String(body.caption) : '',
        sendAs: body?.qqAs,
        qqKey: body?.qqKey ? String(body.qqKey) : undefined,
        qqToken: body?.qqToken ? String(body.qqToken) : undefined,
      })
    }
    return { ...result, emotion: describeEmotion(emotion), delivery }
  }

  startCover(body, onProgress) {
    const job = {
      id: uid('job_'),
      kind: 'cover',
      stage: 'queued',
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      result: null,
      progress: [],
    }
    this.jobs.set(job.id, job)
    const runJob = async () => {
      try {
        const result = await makeCover({
          store: this.store,
          song: String(body?.song ?? ''),
          model: body?.model ? String(body.model) : undefined,
          index: body?.index ? String(body.index) : undefined,
          f0UpKey: body?.keyShift === undefined ? undefined : Number(body.keyShift),
          onProgress: (stage) => {
            job.stage = stage
            job.progress.push({ stage, at: Date.now() })
            try {
              onProgress?.(stage)
            } catch {
              /* ignore */
            }
          },
        })
        job.result = result
        job.status = 'done'
        job.stage = 'done'
      } catch (error) {
        job.status = 'failed'
        job.error = brief(error?.message || error, 1200)
      } finally {
        job.finishedAt = Date.now()
      }
    }
    void runJob()
    return job
  }

  /** Random-voice policy roll (probability + cooldown + hourly cap). */
  async rollRandomVoice() {
    await this.ready
    const cfg = this.store.read()
    const av = cfg.autoVoice || {}
    if (!av.enabled) return { voice: false, reason: '随机语音未启用' }
    const now = Date.now()
    const history = (Array.isArray(av.history) ? av.history : []).filter((t) => now - Number(t) < 3600_000)
    const maxPerHour = Number(av.maxPerHour || 6)
    if (history.length >= maxPerHour) return { voice: false, reason: `本小时已发 ${history.length}/${maxPerHour} 条语音` }
    const cooldownMs = Number(av.cooldownSec || 600) * 1000
    if (av.lastAt && now - Number(av.lastAt) < cooldownMs) {
      return { voice: false, reason: `冷却中（还需 ${Math.ceil((cooldownMs - (now - Number(av.lastAt))) / 1000)}s）` }
    }
    const probability = Math.min(1, Math.max(0, Number(av.probability ?? 0.12)))
    const hit = Math.random() < probability
    if (hit) {
      await this.store.update((draft) => {
        draft.autoVoice = { ...(draft.autoVoice || {}), lastAt: now, history: [...history, now].slice(-200) }
      })
    }
    return { voice: hit, reason: hit ? `概率 ${probability}` : `未命中（概率 ${probability}）` }
  }

  /**
   * Probe only what the current configuration actually uses: the selected TTS
   * provider, the local RVC folder, MSST when configured, the QQ bridge when
   * enabled. `all` widens it to every provider (diagnostics).
   */
  async probeServices({ all = false } = {}) {
    await this.ready
    const config = this.store.read()
    const results = {}
    // Each local service answers on a different path and carries a different
    // marker; checking the marker is what keeps two services that share a port
    // (IndexTTS and MSST both like 7860) from being reported as healthy.
    const probeSpecFor = (id) => {
      if (id === 'gptsovits') return { path: '/docs', marker: 'swagger', name: 'GPT-SoVITS api_v2' }
      if (id === 'msst') return { path: '/config', marker: 'run_inference_single', name: 'MSST_WebUI' }
      if (id === 'indextts') return { path: '/config', marker: 'gen_single', name: 'IndexTTS' }
      if (id === 'onebot') return { path: '/get_login_info', marker: '', name: 'OneBot HTTP' }
      return { path: '/config', marker: '', name: id }
    }
    const addHttp = async (id, label, url) => {
      const spec = probeSpecFor(id)
      const target = `${String(url).replace(/\/$/, '')}${spec.path}`
      const started = Date.now()
      try {
        const response = await fetch(target, { signal: AbortSignal.timeout(5000) })
        const text = await response.text()
        const matched = !spec.marker || text.toLowerCase().includes(String(spec.marker).toLowerCase())
        results[id] = {
          kind: 'http',
          label,
          url,
          ok: response.ok && matched,
          status: response.status,
          ms: Date.now() - started,
          detail: response.ok && !matched ? `端口上不是 ${spec.name}（未找到 ${spec.marker}）` : '',
          error: response.ok && !matched ? `端口被别的服务占用？未找到 ${spec.marker}` : undefined,
        }
      } catch (error) {
        results[id] = { kind: 'http', label, url, ok: false, status: 0, ms: Date.now() - started, error: String(error?.message || error) }
      }
    }

    const activeId = String(config.tts?.provider || 'indextts')
    const providerEntries = all
      ? Object.entries(PROVIDERS)
      : [[activeId, PROVIDERS[activeId]]].filter(([, meta]) => Boolean(meta))
    for (const [id, meta] of providerEntries) {
      const cfg = config.tts?.providers?.[id] ?? {}
      if (meta.kind === 'local') {
        if (!cfg.baseUrl) {
          results[id] = { kind: 'http', label: meta.label, ok: false, detail: '未配置 baseUrl' }
          continue
        }
        await addHttp(id, meta.label, cfg.baseUrl)
      } else {
        results[id] = {
          kind: 'online',
          label: meta.label,
          ok: Boolean(cfg.apiKey),
          detail: cfg.apiKey ? '在线 API：已配置 Key（不发起探测请求）' : '在线 API：未配置 API Key',
          url: cfg.baseUrl || '',
        }
      }
      if (!all) results[id].selected = true
    }

    const rvcRoot = config.cover?.rvcRoot
    const rvcOk = Boolean(rvcRoot && existsSync(rvcRoot))
    const rvcPython = rvcOk ? this.store.detectRvcPython(rvcRoot) : ''
    results.rvc = {
      kind: 'local',
      label: 'RVC（本地）',
      ok: Boolean(rvcOk && rvcPython),
      detail: rvcOk ? `${rvcRoot}${rvcPython ? ' · python 已找到' : ' · 未找到 python'}` : '未配置 RVC 目录',
    }

    if (config.cover?.msstUrl) {
      await addHttp('msst', 'MSST_WebUI', config.cover.msstUrl)
    } else if (all) {
      results.msst = { kind: 'http', label: 'MSST_WebUI', ok: false, detail: '未配置（翻唱将使用 RVC 内置分离）' }
    }

    if (config.qq?.enabled) {
      const bridge = bridgeVoiceInfo(this.store)
      results.qqBridge = {
        kind: 'bridge',
        label: 'qq-bridge 语音库',
        ok: Boolean(bridge.available && bridge.enabled && bridge.toolEnabled),
        detail: bridge.available
          ? `${bridge.audioDir}（语音开关${bridge.enabled ? '开' : '关'}，发送工具${bridge.toolEnabled ? '开' : '关'}）`
          : bridge.reason,
      }
      if (config.qq?.mode === 'onebot-http' && config.qq?.baseUrl) {
        await addHttp('onebot', 'OneBot HTTP', config.qq.baseUrl)
      }
    }

    results.dsh = { kind: 'local', label: 'DSH 宿主', ok: Boolean(this.origin()), detail: this.origin() || '未知 origin' }
    return results
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

function disposeAll(disposers) {
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}

function registerRoutes(studio, webServer) {
  const disposers = []
  const json = (res, code, payload) => sendJson(res, code, payload)
  const guard = async (res, fn) => {
    try {
      await studio.ready
      await fn()
    } catch (error) {
      const status = Number(error?.status) || (error?.code === 'VOICE_CONFLICT' ? 409 : 500)
      json(res, status, {
        error: brief(error?.message || error, 800),
        code: error?.code || null,
        existing: error?.existing || null,
      })
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/state`,
    handler: (req, res) => guard(res, async () => {
      json(res, 200, await studio.state())
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/settings`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        guard(res, async () => json(res, 200, { settings: studio.store.read() }))
        return
      }
      if (method !== 'PUT' && method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const body = await readJson(req, 256 * 1024)
        const settings = await studio.saveSettings(body)
        json(res, 200, { ok: true, settings })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/voices`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        guard(res, async () => json(res, 200, { voices: studio.store.listVoices() }))
        return
      }
      if (method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const body = await readJson(req, MAX_UPLOAD + 1024)
        if (body?.action === 'import-dir') {
          const result = await studio.store.importDir(String(body.dir || ''), {
            recursive: body.recursive !== false,
            mode: body.mode === 'replace' ? 'replace' : 'add',
          })
          json(res, 200, { ok: true, ...result, voices: studio.store.listVoices() })
          return
        }
        if (body?.action === 'delete') {
          await studio.store.deleteVoice(String(body.id || ''))
          json(res, 200, { ok: true, voices: studio.store.listVoices() })
          return
        }
        if (body?.action === 'rename') {
          const voice = await studio.store.renameVoice(String(body.id || ''), String(body.name || ''))
          json(res, 200, { ok: true, voice, voices: studio.store.listVoices() })
          return
        }
        const result = await studio.addVoice(body)
        json(res, 200, { ok: true, ...result, voices: studio.store.listVoices() })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/voice-audio`,
    handler: (req, res) => guard(res, async () => {
      const url = new URL(req.url, 'http://localhost')
      const file = studio.store.voicePath(url.searchParams.get('id') || '')
      if (!file) throw Object.assign(new Error('voice audio not found'), { status: 404 })
      streamFile(req, res, file)
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/audio`,
    handler: (req, res) => guard(res, async () => {
      const url = new URL(req.url, 'http://localhost')
      const wanted = normalizePath(String(url.searchParams.get('path') || ''))
      const root = normalizePath(studio.store.dir)
      if (!wanted.startsWith(root)) throw Object.assign(new Error('outside data dir'), { status: 403 })
      if (!existsSync(wanted)) throw Object.assign(new Error('file not found'), { status: 404 })
      streamFile(req, res, wanted)
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/tts`,
    handler: (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const body = await readJson(req, 1024 * 1024)
        const result = await studio.generate(body)
        json(res, 200, {
          ok: true,
          ...result,
          url: `${BASE}/api/audio?path=${encodeURIComponent(result.file)}`,
        })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/cover`,
    handler: (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const body = await readJson(req, 1024 * 1024)
        const job = studio.startCover(body)
        json(res, 200, { ok: true, job: { id: job.id, status: job.status, stage: job.stage } })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/jobs`,
    handler: (req, res) => guard(res, async () => {
      const url = new URL(req.url, 'http://localhost')
      const job = studio.jobs.get(url.searchParams.get('id') || '')
      if (!job) throw Object.assign(new Error('job not found'), { status: 404 })
      const result = job.result
      json(res, 200, {
        ok: true,
        job: {
          id: job.id,
          status: job.status,
          stage: job.stage,
          error: job.error,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
          result: result
            ? {
                ...result,
                outUrl: `${BASE}/api/audio?path=${encodeURIComponent(result.outWav)}`,
                mp3Url: result.outMp3 ? `${BASE}/api/audio?path=${encodeURIComponent(result.outMp3)}` : '',
                vocalUrl: `${BASE}/api/audio?path=${encodeURIComponent(result.vocal)}`,
              }
            : null,
        },
      })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/probe`,
    handler: (req, res) => guard(res, async () => {
      const url = new URL(req.url, 'http://localhost')
      json(res, 200, { ok: true, services: await studio.probeServices({ all: url.searchParams.get('all') === '1' }) })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/qq`,
    handler: (req, res) => guard(res, async () => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        json(res, 200, { ok: true, status: await qqStatus(studio.store, studio.ctx) })
        return
      }
      const body = await readJson(req, 32 * 1024)
      const result = await sendToQq({
        ctx: studio.ctx,
        store: studio.store,
        file: body?.file ? String(body.file) : '',
        text: body?.text ? String(body.text) : '语音工坊：QQ 通道测试',
        sendAs: body?.sendAs,
      })
      json(res, 200, { ok: result.sent !== false, ...result })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/qq/bridge-enable`,
    handler: (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const result = enableBridgeVoice(studio.store)
        json(res, 200, { ok: true, ...result, status: await qqStatus(studio.store, studio.ctx) })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/qq/sync-dsh-url`,
    handler: (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      guard(res, async () => {
        const origin = studio.origin()
        if (!origin) throw new Error('无法确定当前 DSH 地址')
        const result = setBridgeDshUrl(studio.store, origin)
        json(res, 200, { ok: true, ...result, origin, bridge: bridgeLinkInfo(studio.store) })
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/api/models`,
    handler: (req, res) => guard(res, async () => {
      const url = new URL(req.url, 'http://localhost')
      if (url.searchParams.get('rescan') === '1') {
        const detected = studio.store.detectRvcRoot()
        if (detected && !studio.store.read().cover?.rvcRoot) {
          await studio.store.update((draft) => {
            draft.cover.rvcRoot = detected
            draft.cover.rvcPython = studio.store.detectRvcPython(detected)
          })
        }
      }
      json(res, 200, { ok: true, ...listModels(studio.store) })
    }),
  }))

  return disposeAll(disposers)
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function registerTools(studio, tools) {
  const disposers = []

  disposers.push(tools.register({
    name: 'voice_generate',
    description:
      '发语音/朗读/配音/“用语音说”时优先用我：直接生成语音，并可同时交给 qq-bridge 发送（send_to_qq: true + qq_key/qq_token），不需要先查语音库。Generate spoken audio (TTS) from text and return the local file path. Use it whenever the user asks for a voice, narration, dubbing, a spoken message, or wants text "read out" — including when they asked for it to be sent to QQ afterwards. The provider and reference voice come from the Voice Studio settings; `voice` picks one of the configured reference voices, `emotion`/`intensity` control the delivery and are auto-detected from the text when omitted. Set `send_to_qq` only when the user wants it delivered to QQ; delivery additionally requires QQ to be enabled in the settings page.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact text to speak.' },
        voice: { type: 'string', description: 'Reference voice id or display name from the Voice Studio library. Omit to use the configured default.' },
        provider: { type: 'string', description: 'Provider id: indextts, gptsovits, siliconflow, minimax, mimo, openai. Omit to use the configured default.' },
        emotion: { type: 'string', description: 'Emotion label: happy, angry, sad, fear, disgust, down, surprise, calm, neutral. Omit to auto-detect.' },
        intensity: { type: 'number', description: 'Emotion strength 0-1.' },
        speed: { type: 'number', description: 'Speaking rate multiplier where the provider supports it.' },
        lang: { type: 'string', description: 'Language code for local providers (ZH/EN/JA/AR/ES for IndexTTS).' },
        send_to_qq: { type: 'boolean', description: 'Send the generated audio to the configured QQ target after synthesis.' },
        qq_as: { type: 'string', description: 'record (voice message) or file. Defaults to the settings value.' },
        caption: { type: 'string', description: 'Optional short text sent before the audio on QQ.' },
        qq_key: { type: 'string', description: 'QQ session key from the wake prompt (group:<id> or private:<id>). Required for automatic delivery through qq-bridge.' },
        qq_token: { type: 'string', description: 'QQ session token from the wake prompt. Required for automatic delivery through qq-bridge.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          detail: { type: 'string' },
          file: { type: 'string' },
          provider: { type: 'string' },
          emotion: { type: 'string' },
          sent: { type: 'boolean' },
        },
        required: ['detail'],
      },
      render: (args, result) => [
        { type: 'text', text: String(result?.detail ?? `voice: ${String(args.text ?? '').slice(0, 60)}`) },
      ],
    },
    execute: async (args) => {
      await studio.ready
      const config = studio.store.read()
      const emotion = await resolveEmotion(
        studio.ctx,
        String(args.text ?? ''),
        args.emotion === undefined ? undefined : { label: args.emotion, intensity: args.intensity },
        config.emotion?.mode || 'auto',
      )
      const result = await synthesize({
        store: studio.store,
        text: String(args.text ?? ''),
        providerId: args.provider ? String(args.provider) : undefined,
        voiceId: args.voice ? String(args.voice) : undefined,
        emotion,
        speed: args.speed === undefined ? undefined : Number(args.speed),
        lang: args.lang ? String(args.lang) : undefined,
      })
      let delivery = { sent: false, reason: '未请求发送' }
      if (args.send_to_qq === true) {
        delivery = await sendToQq({
          ctx: studio.ctx,
          store: studio.store,
          file: result.file,
          text: args.caption ? String(args.caption) : '',
          sendAs: args.qq_as,
          qqKey: args.qq_key ? String(args.qq_key) : undefined,
          qqToken: args.qq_token ? String(args.qq_token) : undefined,
        })
      }
      const detail = [
        `已生成语音：${result.file}`,
        `提供商：${result.providerLabel}（${result.provider}）`,
        result.voice ? `音色：${result.voice}` : '',
        `情绪：${describeEmotion(emotion)}${result.emotionApplied ? '（已应用）' : '（该提供商无情绪参数）'}`,
        `文件：${(result.bytes / 1024).toFixed(0)} KiB，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`,
        delivery.sent ? `已发送到 QQ（${delivery.detail}）` : args.send_to_qq ? `QQ 未发送：${delivery.reason}` : '',
      ].filter(Boolean).join('\n')
      return { detail, file: result.file, provider: result.provider, emotion: describeEmotion(emotion), sent: Boolean(delivery.sent) }
    },
  }))

  disposers.push(tools.register({
    name: 'song_cover',
    description:
      'Make a song cover: take a song the user names, separate vocals and instrumental, convert the vocal with an RVC voice model, and return the mixed audio. Use it whenever the user asks to 翻唱 / cover / sing a song in a given voice. The song argument accepts a title (searched in the configured music folders), a local audio path, or a URL when downloading is enabled. The RVC model defaults to the settings choice and can be any model id from the inventory. The call runs the whole pipeline synchronously and can take a few minutes; the returned paths are the mixed MP3/WAV.',
    parameters: {
      type: 'object',
      properties: {
        song: { type: 'string', description: 'Song title, absolute audio path, or URL.' },
        model: { type: 'string', description: 'RVC model id (e.g. shaonv.pth) or absolute .pth path. Omit to use the configured default.' },
        index: { type: 'string', description: 'Optional index file path; omit to auto-match the model.' },
        key_shift: { type: 'number', description: 'Semitone shift for the converted vocal. Default from settings, usually 0.' },
        send_to_qq: { type: 'boolean', description: 'Send the finished cover to the configured QQ target.' },
        caption: { type: 'string', description: 'Optional short text sent before the audio on QQ.' },
        qq_key: { type: 'string', description: 'QQ session key from the wake prompt (group:<id> / private:<id>).' },
        qq_token: { type: 'string', description: 'QQ session token from the wake prompt.' },
      },
      required: ['song'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          detail: { type: 'string' },
          mp3: { type: 'string' },
          wav: { type: 'string' },
          sent: { type: 'boolean' },
        },
        required: ['detail'],
      },
      render: (args, result) => [
        { type: 'text', text: String(result?.detail ?? `cover: ${String(args.song ?? '')}`) },
      ],
    },
    execute: async (args) => {
      await studio.ready
      const job = studio.startCover({
        song: String(args.song ?? ''),
        model: args.model ? String(args.model) : undefined,
        index: args.index ? String(args.index) : undefined,
        keyShift: args.key_shift === undefined ? undefined : Number(args.key_shift),
      })
      const deadline = Date.now() + 60 * 60 * 1000
      while (job.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      if (job.status === 'running') throw new Error('翻唱超时（>60 分钟）')
      if (job.status === 'failed') throw new Error(`翻唱失败：${job.error}`)
      const result = job.result
      let delivery = { sent: false, reason: '未请求发送' }
      if (args.send_to_qq === true) {
        delivery = await sendToQq({
          ctx: studio.ctx,
          store: studio.store,
          file: result.outMp3 || result.outWav,
          text: args.caption ? String(args.caption) : '',
          qqKey: args.qq_key ? String(args.qq_key) : undefined,
          qqToken: args.qq_token ? String(args.qq_token) : undefined,
        })
      }
      const detail = [
        `翻唱完成：${result.outMp3 || result.outWav}`,
        result.outMp3 ? `无损：${result.outWav}` : '',
        `歌曲：${basename(result.song)}（${result.songSource}）`,
        result.candidates?.length > 1 ? `候选：${result.candidates.slice(0, 3).map((item) => basename(item.path)).join(' / ')}` : '',
        `模型：${result.model}${result.index ? `，索引 ${basename(result.index)}` : '，无索引'}`,
        `分离：${result.separation}${result.separationNote ? `（${result.separationNote}）` : ''}`,
        `时长：${result.durationSec}s，总耗时 ${(result.elapsedMs / 1000).toFixed(0)}s`,
        delivery.sent ? `已发送到 QQ（${delivery.detail}）` : args.send_to_qq ? `QQ 未发送：${delivery.reason}` : '',
      ].filter(Boolean).join('\n')
      return { detail, mp3: result.outMp3, wav: result.outWav, sent: Boolean(delivery.sent) }
    },
  }))

  disposers.push(tools.register({
    name: 'voice_studio_info',
    description:
      'Inspect the Voice Studio setup before generating audio: which TTS providers are configured, which reference voices are in the library, which RVC models are installed, and whether the local services answer. Use `action: "probe"` to test reachability, `"voices"` for reference-voice ids, `"models"` for RVC .pth models, `"providers"` for the provider list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'providers | voices | models | probe | settings' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args, result) => [
        { type: 'text', text: String(result?.detail ?? `voice studio info: ${String(args.action ?? '')}`) },
      ],
    },
    execute: async (args) => {
      await studio.ready
      const action = String(args.action || 'providers').toLowerCase()
      const cfg = studio.store.read()
      if (action === 'voices') {
        const voices = studio.store.listVoices()
        return {
          detail: voices.length
            ? voices.map((voice) => `- ${voice.id}  ${voice.name}${voice.durationSec ? ` (${voice.durationSec}s)` : ''}${voice.available ? '' : ' [文件缺失]'}`).join('\n')
            : '(参考音色库为空)',
        }
      }
      if (action === 'models') {
        const models = listModels(studio.store)
        return {
          detail: [
            `RVC 根目录：${models.root || '(未配置)'}`,
            `Python：${models.python || '(未找到)'}`,
            `分离：${models.msstConfigured ? 'MSST_WebUI' : 'RVC 内置 PyMSS'}`,
            ...models.models.map((model) => `- ${model.id}（${(model.size / 1024 / 1024).toFixed(0)} MiB）`),
            ...models.indexes.slice(0, 10).map((index) => `  index: ${index.id}`),
          ].join('\n'),
        }
      }
      if (action === 'probe') {
        const services = await studio.probeServices()
        return {
          detail: Object.entries(services)
            .map(([, service]) => {
              if (service.ok) return `- ${service.label}: OK${service.ms ? ` (${service.ms}ms)` : ''}`
              const reason = service.error || (service.status ? `HTTP ${service.status}` : '') || service.detail || '不可用'
              return `- ${service.label}: 不可用（${reason}）`
            })
            .join('\n'),
        }
      }
      if (action === 'settings') {
        return { detail: brief(JSON.stringify(cfg, null, 2), 1800) }
      }
      const active = cfg.tts?.provider || 'indextts'
      return {
        detail: [
          `当前提供商：${active}`,
          ...Object.entries(PROVIDERS).map(([id, meta]) => `- ${id}: ${meta.label}${id === active ? ' ←' : ''}`),
          `情绪来源模式：${cfg.emotion?.mode || 'auto'}`,
          `QQ：${cfg.qq?.enabled ? cfg.qq?.mode : '未启用'}`,
          `参考音色 ${studio.store.listVoices().length} 个；RVC 模型 ${listModels(studio.store).models.length} 个`,
        ].join('\n'),
      }
    },
  }))

  disposers.push(tools.register({
    name: 'voice_random_check',
    description:
      'Roll the random-voice policy before replying in a QQ conversation. Returns {voice: true} when this reply should be spoken instead of typed. Call it once per reply when the random-voice setting is enabled; on true, send the reply through voice_generate (or song_cover only if the user asked for singing) with send_to_qq and the qq_key/qq_token from the wake prompt, and skip the equivalent text. Never use it for songs: 唱歌 never goes through the random path.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { detail: { type: 'string' }, voice: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['detail'],
      },
      render: (_args, result) => [{ type: 'text', text: String(result?.detail ?? 'random voice: ?') }],
    },
    execute: async () => {
      await studio.ready
      const result = await studio.rollRandomVoice()
      return {
        detail: result.voice ? `随机语音命中：${result.reason}` : `随机语音未命中：${result.reason}`,
        voice: result.voice,
        reason: result.reason,
      }
    },
  }))

  return disposeAll(disposers)
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  diag('apply entered')
  const studio = new VoiceStudio(ctx)
  ctx.effect(() => {
    const cleanup = []
    const start = async () => {
      try {
        await studio.ready
        diag('store ready')
      } catch (error) {
        diag(`store load failed: ${String(error?.stack || error)}`)
        return
      }
      try {
        cleanup.push(registerRoutes(studio, ctx.webServer))
        diag('routes registered')
      } catch (error) {
        diag(`routes failed: ${String(error?.stack || error)}`)
      }
      try {
        cleanup.push(registerTools(studio, ctx.tools))
        diag('tools registered')
      } catch (error) {
        diag(`tools failed: ${String(error?.stack || error)}`)
      }
      try {
        const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
        if (systemPrompt && typeof systemPrompt.section === 'function') {
          cleanup.push(systemPrompt.section({
            name: 'voice-studio:qq',
            order: 1000,
            text: () => {
              // Stay silent unless this agent can actually see the tools.
              try {
                if (typeof ctx.tools?.get === 'function' && !ctx.tools.get('voice_generate')) return ''
              } catch {
                return ''
              }
              return VOICE_STUDIO_PROMPT_TEXT
            },
          }))
          diag('prompt section registered')
        }
      } catch (error) {
        diag(`prompt section skipped: ${String(error?.message || error)}`)
      }
    }
    void start()
    return () => {
      for (const dispose of cleanup.splice(0)) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  })
}

// Cordis reads `inject` from the plugin object itself; a module-level export is
// not enough when the default export is the function (the loader activates the
// default export, and an un-injected service access throws at registration).
apply.inject = ['tools', 'webServer']

export default apply
