/**
 * Emotion resolution for Voice Studio.
 *
 * Resolution order (highest priority first):
 *   1. what the caller passes (an agent tool argument, or the settings page)
 *   2. a DSH emotion capability, when one is registered on this Host: the
 *      plugin looks it up by service name and calls `classify`/`detect`
 *      defensively, so any future emotion plugin that follows that shape is
 *      picked up without a code change
 *   3. a small built-in lexicon, so "有情感的语音" works out of the box
 *
 * The eight dimensions are IndexTTS's vectors, which are also expressive
 * enough to map onto the other providers (MiniMax enum, CosyVoice prompt,
 * MiMo style prompt).
 */
const DIMENSIONS = ['happy', 'angry', 'sad', 'fear', 'disgust', 'down', 'surprise', 'calm']

// Aliases used by dsh-emotion (高兴/愤怒/悲伤/恐惧/反感/低落/惊讶/自然) and by
// users typing Chinese labels directly.
export const ALIASES = {
  高兴: 'happy',
  开心: 'happy',
  愤怒: 'angry',
  生气: 'angry',
  悲伤: 'sad',
  难过: 'sad',
  恐惧: 'fear',
  害怕: 'fear',
  反感: 'disgust',
  厌恶: 'disgust',
  低落: 'down',
  沮丧: 'down',
  惊讶: 'surprise',
  惊喜: 'surprise',
  自然: 'calm',
  平静: 'calm',
  中性: 'neutral',
}

export const EMOTION_LABELS = {
  happy: '开心',
  angry: '生气',
  sad: '悲伤',
  fear: '害怕',
  disgust: '厌恶',
  down: '低落',
  surprise: '惊喜',
  calm: '平静',
  neutral: '中性',
}

const LEXICON = {
  happy: ['开心', '高兴', '快乐', '哈哈', '太好了', '喜欢', '棒', '耶', '愉快', '幸福', 'happy', 'great', 'nice'],
  angry: ['生气', '愤怒', '气死', '烦死', '滚', '讨厌', '混蛋', '可恶', 'angry', 'mad'],
  sad: ['难过', '伤心', '哭', '眼泪', '遗憾', '可惜', 'sad', 'cry'],
  fear: ['害怕', '恐怖', '可怕', '吓', '危险', '担心', '紧张', 'fear', 'scared'],
  disgust: ['恶心', '厌恶', '反感', '嫌弃', 'disgusting'],
  down: ['累', '疲惫', '没劲', '丧', '无聊', '孤独', '失落', '低落', 'tired'],
  surprise: ['哇', '竟然', '居然', '没想到', '惊喜', '天哪', 'wow', 'surprise'],
  calm: ['平静', '安静', '慢慢', '温柔', '轻轻', 'calm', 'gently'],
}

const NEGATIVE_ZH = {
  happy: '用开心、轻快的语气',
  angry: '用生气、强硬的语气',
  sad: '用悲伤、难过的语气',
  fear: '用害怕、紧张的语气',
  disgust: '用厌恶、嫌弃的语气',
  down: '用低沉、疲惫的语气',
  surprise: '用惊喜、惊讶的语气',
  calm: '用平静、温柔的语气',
}

const NEGATIVE_EN = {
  happy: 'Can you say it with a happy emotion?',
  angry: 'Can you say it with an angry emotion?',
  sad: 'Can you say it with a sad emotion?',
  fear: 'Can you say it with a fearful emotion?',
  disgust: 'Can you say it with a disgusted emotion?',
  down: 'Can you say it in a low, tired voice?',
  surprise: 'Can you say it with a surprised emotion?',
  calm: 'Can you say it calmly and gently?',
}

const MINIMAX_ENUM = {
  happy: 'happy',
  angry: 'angry',
  sad: 'sad',
  fear: 'fearful',
  disgust: 'disgusted',
  surprise: 'surprised',
  calm: 'calm',
  down: 'sad',
}

/** Score the text against the lexicon; returns the dominant label + intensity. */
export function classifyText(text) {
  const source = String(text || '').toLowerCase()
  const scores = {}
  for (const [label, words] of Object.entries(LEXICON)) {
    let score = 0
    for (const word of words) {
      if (!source.includes(word.toLowerCase())) continue
      score += 1
    }
    if (score > 0) scores[label] = score
  }
  const entries = Object.entries(scores)
  if (entries.length === 0) return { label: 'neutral', intensity: 0, source: 'default' }
  entries.sort((a, b) => b[1] - a[1])
  const [label, score] = entries[0]
  const intensity = Math.min(0.95, 0.35 + score * 0.15)
  return { label, intensity, source: 'lexicon' }
}

function normalizeExplicit(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const raw = value.trim()
    const label = raw.toLowerCase()
    if (label === 'neutral' || label === 'none' || label === '') return { label: 'neutral', intensity: 0, source: 'explicit' }
    if (label in NEGATIVE_ZH) return { label, intensity: 0.7, source: 'explicit' }
    if (raw in ALIASES) return { label: ALIASES[raw], intensity: 0.7, source: 'explicit' }
    const zh = Object.entries(EMOTION_LABELS).find(([, text]) => text === raw)
    if (zh) return { label: zh[0], intensity: 0.7, source: 'explicit' }
    return null
  }
  if (typeof value === 'object') {
    const rawLabel = String(value.label || value.emotion || value.mood || '')
    const label = (ALIASES[rawLabel] || rawLabel).toLowerCase()
    if (!(label in NEGATIVE_ZH) && !(label in EMOTION_LABELS)) return null
    const intensity = Number(value.intensity ?? value.weight ?? 0.7)
    return {
      label: label === 'neutral' ? 'neutral' : label,
      intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.7,
      source: 'explicit',
    }
  }
  return null
}

/**
 * Ask the installed emotion plugin, if there is one.
 *
 * Three shapes are probed because emotion plugins in the DSH ecosystem expose
 * different surfaces (see research/qq-emotion.md):
 *   1. a Host service (`ctx.get('emotion')`) with classify/detect-like methods
 *   2. the `get_mood` tool registered by `dsh-emotion` (label/valence/intensity)
 *   3. that same plugin's HTTP state route (`POST /emotion/api/state`)
 * Every step is defensive: anything unexpected falls through to the next one.
 */
async function callTool(ctx, name, args) {
  const tools = ctx && ctx.tools
  if (!tools || typeof tools.get !== 'function' || !tools.get(name)) return null
  if (typeof tools.execute !== 'function') return null
  try {
    const result = await tools.execute({
      callId: `voice-studio-${Date.now()}`,
      name,
      arguments: args,
      signal: AbortSignal.timeout(20000),
    })
    if (!result || result.isError) return null
    return result.value === undefined ? result : result.value
  } catch {
    return null
  }
}

async function askHttpEmotion(ctx) {
  const origin = ctx && ctx.webServer && typeof ctx.webServer.getOrigin === 'function' ? ctx.webServer.getOrigin() : ''
  if (!origin) return null
  try {
    const response = await fetch(`${String(origin).replace(/\/$/, '')}/emotion/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return null
    const body = await response.json()
    const value = body && body.value !== undefined ? body.value : body && body.data !== undefined ? body.data : body
    const normalized = normalizeExplicit(value)
    if (normalized) return { ...normalized, source: 'dsh:emotion/api' }
  } catch {
    /* route absent or slow */
  }
  return null
}

export async function askDshEmotion(ctx, text) {
  if (!ctx) return null
  for (const name of ['emotion', 'emotions', 'sentiment', 'affect']) {
    let service
    try {
      service = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      service = undefined
    }
    if (!service) continue
    for (const method of ['classify', 'detect', 'analyze', 'analyse', 'infer']) {
      const fn = service[method]
      if (typeof fn !== 'function') continue
      try {
        const result = await fn.call(service, text)
        const normalized = normalizeExplicit(result)
        if (normalized) return { ...normalized, source: `dsh:${name}.${method}` }
      } catch {
        /* capability exists but this call does not fit; try the next one */
      }
    }
  }
  const mood = normalizeExplicit(await callTool(ctx, 'get_mood', {}))
  if (mood) return { ...mood, source: 'dsh:get_mood' }
  return askHttpEmotion(ctx)
}

/**
 * @returns {Promise<{label: string, intensity: number, source: string}>}
 */
export async function resolveEmotion(ctx, text, explicit, mode = 'auto') {
  const direct = normalizeExplicit(explicit)
  if (direct) return direct
  if (mode === 'off' || mode === 'manual') return { label: 'neutral', intensity: 0, source: 'off' }
  const fromDsh = await askDshEmotion(ctx, text).catch(() => null)
  if (fromDsh) return fromDsh
  return classifyText(text)
}

/** IndexTTS emotion-vector form: one hot dimension scaled by intensity. */
export function toVector(emotion) {
  const vector = DIMENSIONS.map(() => 0)
  if (!emotion || emotion.label === 'neutral' || !(emotion.label in EMOTION_LABELS)) return vector
  const index = DIMENSIONS.indexOf(emotion.label)
  if (index < 0) return vector
  vector[index] = Math.min(1, Math.max(0.05, emotion.intensity || 0.6))
  return vector
}

export function toMinimax(emotion) {
  if (!emotion || emotion.label === 'neutral') return ''
  return MINIMAX_ENUM[emotion.label] || ''
}

/** CosyVoice2 style prefix: "<instruction> <|endofprompt|> <text>". */
export function toCosyPrefix(emotion) {
  if (!emotion || emotion.label === 'neutral') return ''
  const instruction = NEGATIVE_EN[emotion.label]
  return instruction ? `${instruction} <|endofprompt|>` : ''
}

export function toMimoStyle(emotion) {
  if (!emotion || emotion.label === 'neutral') return ''
  const base = NEGATIVE_ZH[emotion.label]
  if (!base) return ''
  const intensity = emotion.intensity || 0.6
  const degree = intensity > 0.8 ? '非常强烈地' : intensity > 0.55 ? '明显' : '轻微'
  return `${degree}${base}`
}

export function describeEmotion(emotion) {
  if (!emotion || emotion.label === 'neutral') return 'neutral'
  return `${emotion.label}(${(emotion.intensity || 0).toFixed(2)}, ${emotion.source})`
}
