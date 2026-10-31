/**
 * QQ delivery.
 *
 * The deployed setup is a second bridge: QQ -> SnowLuma -> qq-bridge -> DSH.
 * That bridge owns the QQ connection and exposes its own `qq_send_voice` MCP
 * tool, which can only send audio from its own voice library. So this plugin
 * does NOT talk to SnowLuma/OneBot in bridge mode: it renders the audio, copies
 * it into the bridge's library, and hands the send to the bridge's tool.
 *
 * Adapter order:
 *   1. `bridge`      — copy into <qq-bridge>/audio, call mcp__snowluma__qq_send_voice
 *   2. `onebot-http` — direct OneBot v11 HTTP (legacy, only when explicitly configured)
 *   3. `shell`       — explicit command template
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

import { brief, fetchJson, probe, run } from './util.js'

const VOICE_TOOL_NAMES = ['mcp__snowluma__qq_send_voice', 'qq_send_voice', 'qq_voice_send']

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultMediaDir() {
  return join(dshHome(), 'media', 'onebot')
}

/** Read the qq-bridge config.json (null when the bridge is not configured). */
export function readBridgeConfig(store) {
  const root = store.bridgeRoot()
  if (!root) return null
  const file = join(root, 'config.json')
  try {
    return { root, file, config: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

/** Where the bridge's sendable voice library lives, plus its limits. */
export function bridgeVoiceInfo(store) {
  const found = readBridgeConfig(store)
  if (!found) return { available: false, reason: '未找到 qq-bridge（在设置里填 qq-bridge 目录）' }
  const voice = found.config?.socialV2?.voice ?? {}
  const tools = found.config?.socialV2?.tools ?? {}
  const dir = voice.dir ? String(voice.dir) : 'audio'
  return {
    available: true,
    root: found.root,
    audioDir: join(found.root, dir),
    enabled: voice.enabled === true,
    toolEnabled: tools.sendVoice === true,
    maxSeconds: Number(voice.maxSeconds || 300),
    maxBytes: Number(voice.maxBytes || 20 * 1024 * 1024),
    maxPerMinute: Number(voice.maxPerMinute || 2),
  }
}

/** The DSH endpoint the bridge is currently pointed at. */
export function bridgeLinkInfo(store) {
  const found = readBridgeConfig(store)
  if (!found) return null
  const dsh = found.config?.dsh ?? {}
  return {
    root: found.root,
    file: found.file,
    dshBaseUrl: String(dsh.baseUrl || ''),
    dshModel: String(dsh.model || ''),
    dshAuthToken: Boolean(dsh.authToken),
  }
}

/**
 * Point the bridge at the current DSH origin. DSH Desktop picks a fresh loopback
 * port on every launch, so this is the one config value that goes stale; the
 * settings page shows it and offers this explicit sync.
 */
export function setBridgeDshUrl(store, origin) {
  const found = readBridgeConfig(store)
  if (!found) throw new Error('未找到 qq-bridge 配置')
  found.config.dsh = { ...(found.config.dsh || {}), baseUrl: String(origin) }
  writeFileSync(found.file, JSON.stringify(found.config, null, 2), 'utf8')
  return { file: found.file, dshBaseUrl: String(origin), restartRequired: true }
}

/**
 * Flip the bridge's two voice switches. This is a deliberate, narrow write into
 * another project's config, so it is exposed as an explicit action from the
 * settings page, never done silently.
 */
export function enableBridgeVoice(store) {
  const found = readBridgeConfig(store)
  if (!found) throw new Error('未找到 qq-bridge 配置')
  const cfg = found.config
  cfg.socialV2 = cfg.socialV2 || {}
  cfg.socialV2.voice = { ...(cfg.socialV2.voice || {}), enabled: true }
  cfg.socialV2.tools = { ...(cfg.socialV2.tools || {}), sendVoice: true }
  writeFileSync(found.file, JSON.stringify(cfg, null, 2), 'utf8')
  return { file: found.file, restartRequired: true }
}

/** Copy a rendered file into the bridge library; returns its library-relative name. */
export function importIntoBridgeLibrary(store, file) {
  const info = bridgeVoiceInfo(store)
  if (!info.available) throw new Error(info.reason)
  const stat = statSync(file)
  if (stat.size > info.maxBytes) {
    throw new Error(`音频 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 qq-bridge 上限 ${(info.maxBytes / 1024 / 1024).toFixed(0)}MB`)
  }
  const targetDir = join(info.audioDir, 'voice-studio')
  mkdirSync(targetDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const slug = basename(file).replace(/[^\w.-]+/g, '_').slice(-48)
  const name = `vs-${stamp}-${slug}`
  copyFileSync(file, join(targetDir, name))
  return { voice: `voice-studio/${name}`, path: join(targetDir, name), libraryDir: info.audioDir, info }
}

/** Send one rendered audio file (or cover) to QQ. */
export async function sendToQq({ ctx, store, file, text, caption, sendAs, qqKey, qqToken }) {
  const config = store.read()
  const qq = config.qq || {}
  if (!qq.enabled) return { sent: false, reason: 'QQ 发送未启用（设置 → 语音工坊 → QQ）' }
  if (!file || !existsSync(file)) return { sent: false, reason: `没有可发送的文件：${file || '(空)'}` }
  if (qq.mode === 'off') return { sent: false, reason: 'QQ 发送已关闭' }

  if (qq.mode === 'bridge' || qq.mode === 'auto' || qq.mode === undefined) {
    const result = await sendViaBridge(ctx, store, file, qq, { qqKey, qqToken, caption })
    if (result.sent || qq.mode === 'bridge') return result
    // auto mode falls through to the legacy adapters when the bridge is absent.
    if (result.reason && !/未找到 qq-bridge/.test(result.reason)) return result
  }

  if (qq.mode === 'onebot-http' || qq.mode === 'auto') {
    if (qq.baseUrl) {
      try {
        return await sendViaOnebot(file, qq, sendAs || qq.sendAs || 'record', caption || text)
      } catch (error) {
        return { sent: false, via: 'onebot', reason: brief(error?.message || error, 300) }
      }
    }
  }

  if (qq.mode === 'shell' || qq.shellTemplate) {
    return sendViaShell(file, qq, sendAs || qq.sendAs || 'record', caption || text)
  }
  return { sent: false, reason: '没有可用的 QQ 通道' }
}

async function sendViaBridge(ctx, store, file, qq, { qqKey, qqToken, caption }) {
  const info = bridgeVoiceInfo(store)
  if (!info.available) return { sent: false, via: 'bridge', reason: info.reason }
  let imported
  try {
    imported = importIntoBridgeLibrary(store, file)
  } catch (error) {
    return { sent: false, via: 'bridge', reason: brief(error?.message || error, 300) }
  }
  const base = {
    via: 'bridge',
    libraryVoice: imported.voice,
    libraryPath: imported.path,
    bridgeEnabled: info.enabled,
    bridgeToolEnabled: info.toolEnabled,
  }
  if (!info.enabled || !info.toolEnabled) {
    return {
      ...base,
      sent: false,
      reason:
        '已放入 qq-bridge 语音库，但 bridge 的语音开关未开启（socialV2.voice.enabled / socialV2.tools.sendVoice）。' +
        '在设置页点「打开 bridge 语音开关」并重启 qq-bridge 后再发。',
    }
  }
  const tools = ctx && ctx.tools
  const toolName = VOICE_TOOL_NAMES.find((name) => tools && typeof tools.get === 'function' && tools.get(name))
  if (!toolName) {
    return { ...base, sent: false, reason: `语音已入桥接库（${imported.voice}），但宿主没有注册 qq_send_voice 工具，无法自动发出` }
  }
  if (!qqKey || !qqToken) {
    return {
      ...base,
      sent: false,
      reason: '语音已入桥接库，但缺少会话 key/token（由 agent 从唤醒提示传入）；也可以让 agent 自己调用 qq_send_voice',
      next: { tool: toolName, arguments: { key: qqKey || '<key>', token: '<token>', voice: imported.voice } },
    }
  }
  try {
    const result = await tools.execute({
      callId: `voice-studio-${Date.now()}`,
      name: toolName,
      arguments: { key: qqKey, token: qqToken, voice: imported.voice, ...(caption ? { label: String(caption).slice(0, 20) } : {}) },
      signal: AbortSignal.timeout(180000),
    })
    if (!result || result.isError) {
      return { ...base, sent: false, reason: `qq_send_voice 返回错误：${brief(JSON.stringify(result?.error ?? result), 300)}` }
    }
    return { ...base, sent: true, detail: `voice ${imported.voice}` }
  } catch (error) {
    return { ...base, sent: false, reason: brief(error?.message || error, 300) }
  }
}

async function onebotCall(baseUrl, token, action, payload) {
  const url = `${baseUrl.replace(/\/$/, '')}/${action}`
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const result = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload), timeoutMs: 120000 })
  const retcode = Number(result && (result.retcode !== undefined ? result.retcode : result.data && result.data.retcode))
  if (retcode !== 0 && result && result.status !== 'ok') {
    throw new Error(`OneBot ${action} 失败：retcode=${retcode} ${brief((result && (result.message || result.wording)) || JSON.stringify(result), 300)}`)
  }
  return result
}

async function sendViaOnebot(file, qq, kind, caption) {
  const baseUrl = String(qq.baseUrl || '').trim()
  if (!baseUrl) return { sent: false, via: 'onebot', reason: '未配置 OneBot 地址' }
  const targetId = String(qq.targetId || '').trim()
  if (!targetId) return { sent: false, via: 'onebot', reason: '未配置 QQ 目标' }
  const isGroup = qq.targetType === 'group'
  const idKey = isGroup ? 'group_id' : 'user_id'
  const path = file.replace(/\\/g, '/')
  const fileUri = /^[a-zA-Z]:\//.test(path) ? `file:///${path}` : `file://${path}`
  if (kind === 'record') {
    const message = [{ type: 'record', data: { file: fileUri } }]
    if (caption) message.unshift({ type: 'text', data: { text: caption } })
    await onebotCall(baseUrl, qq.accessToken, isGroup ? 'send_group_msg' : 'send_private_msg', { [idKey]: targetId, message })
    return { sent: true, via: 'onebot:record', detail: `${isGroup ? 'group' : 'private'} ${targetId}` }
  }
  await onebotCall(baseUrl, qq.accessToken, isGroup ? 'upload_group_file' : 'upload_private_file', {
    [idKey]: targetId,
    file: fileUri,
    name: basename(file),
  })
  return { sent: true, via: 'onebot:upload', detail: `${isGroup ? 'group' : 'private'} ${targetId}` }
}

async function sendViaShell(file, qq, kind, text) {
  const template = String(qq.shellTemplate || '').trim()
  if (!template) return { sent: false, reason: '未配置 shell 模板' }
  const command = template.replaceAll('{file}', file).replaceAll('{text}', text || '').replaceAll('{kind}', kind)
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]
  const { code, stdout, stderr } = await run(shell, shellArgs, { timeoutMs: 180000 })
  return code === 0 ? { sent: true, via: 'shell', detail: brief(stdout, 300) } : { sent: false, via: 'shell', reason: brief(stderr || stdout, 400) }
}

/** Status for the settings page and the tools. */
export async function qqStatus(store, ctx) {
  const config = store.read()
  const qq = config.qq || {}
  if (!qq.enabled) return { enabled: false, ok: false, mode: 'off', detail: '未启用' }
  if (qq.mode === 'bridge' || qq.mode === 'auto' || qq.mode === undefined) {
    const info = bridgeVoiceInfo(store)
    if (!info.available) return { enabled: true, ok: false, mode: 'bridge', detail: info.reason }
    let toolName = ''
    try {
      toolName = VOICE_TOOL_NAMES.find((name) => ctx?.tools?.get?.(name)) || ''
    } catch {
      toolName = ''
    }
    return {
      enabled: true,
      ok: info.enabled && info.toolEnabled && Boolean(toolName),
      mode: 'bridge',
      detail: [
        `qq-bridge：${info.root}`,
        `语音库：${info.audioDir}`,
        info.enabled ? '语音开关：开' : '语音开关：关',
        info.toolEnabled ? '发送工具：开' : '发送工具：关',
        toolName ? `已注册：${toolName}` : '未注册 qq_send_voice（重启 qq-bridge/DSH 后可注册）',
      ].join(' · '),
    }
  }
  if (qq.mode === 'shell') {
    return { enabled: true, mode: 'shell', ok: Boolean(qq.shellTemplate), detail: qq.shellTemplate ? '使用 shell 模板' : '未配置模板' }
  }
  const baseUrl = String(qq.baseUrl || '').trim()
  const reachable = await probe(`${baseUrl.replace(/\/$/, '')}/get_login_info`, 4000)
  if (!reachable.ok) return { enabled: true, ok: false, mode: 'onebot-http', detail: `不可达：${brief(reachable.error || `HTTP ${reachable.status}`, 200)}` }
  let body = {}
  try {
    body = JSON.parse(reachable.head)
  } catch {
    body = {}
  }
  const info = (body && body.data) || {}
  return { enabled: true, ok: true, mode: 'onebot-http', detail: info.nickname ? `已连接 ${info.nickname}` : '已连接' }
}
