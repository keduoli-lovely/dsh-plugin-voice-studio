/**
 * Minimal WAV codec + mixing, so the cover pipeline needs no local Python.
 *
 * Reads PCM 8/16/24/32-bit and IEEE float 32/64-bit WAV, writes 24-bit PCM,
 * resamples linearly, mixes a centred vocal over a stereo bed and normalises the
 * peak. Everything is plain Node — the only optional external tool left is
 * ffmpeg, used for the MP3/loudness pass when it is available.
 */
import { spawn } from 'node:child_process'

function readChunks(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件')
  }
  const chunks = []
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    chunks.push({ id, start: offset + 8, size })
    offset += 8 + size + (size % 2)
  }
  return chunks
}

/** @returns {{sampleRate:number, channels:number, bits:number, float:boolean, samples:Float32Array}} */
export function decodeWav(buffer) {
  const chunks = readChunks(buffer)
  const fmt = chunks.find((chunk) => chunk.id === 'fmt ')
  const data = chunks.find((chunk) => chunk.id === 'data')
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块')
  const format = buffer.readUInt16LE(fmt.start)
  const channels = buffer.readUInt16LE(fmt.start + 2)
  const sampleRate = buffer.readUInt32LE(fmt.start + 4)
  const bits = buffer.readUInt16LE(fmt.start + 14)
  const float = format === 3 || format === 0xfffe
  if (channels < 1 || channels > 8) throw new Error(`不支持的声道数 ${channels}`)
  const bytesPer = bits / 8
  const frames = Math.floor(data.size / (bytesPer * channels))
  const samples = new Float32Array(frames * channels)
  let p = data.start
  for (let i = 0; i < samples.length; i += 1) {
    let value
    if (float && bits === 32) value = buffer.readFloatLE(p)
    else if (float && bits === 64) value = buffer.readDoubleLE(p)
    else if (bits === 8) value = (buffer.readUInt8(p) - 128) / 128
    else if (bits === 16) value = buffer.readInt16LE(p) / 32768
    else if (bits === 24) value = buffer.readIntLE(p, 3) / 8388608
    else if (bits === 32) value = buffer.readInt32LE(p) / 2147483648
    else throw new Error(`不支持的位深 ${bits}`)
    samples[i] = value
    p += bytesPer
  }
  return { sampleRate, channels, bits, float, samples }
}

/** Encode interleaved float samples as a 24-bit PCM WAV. */
export function encodeWav24(sampleRate, channels, samples) {
  const frames = Math.floor(samples.length / channels)
  const dataSize = frames * channels * 3
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 3, 28)
  buffer.writeUInt16LE(channels * 3, 32)
  buffer.writeUInt16LE(24, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  let p = 44
  for (let i = 0; i < frames * channels; i += 1) {
    let value = Math.max(-1, Math.min(1, samples[i]))
    value = Math.round(value * 8388607)
    buffer.writeIntLE(value, p, 3)
    p += 3
  }
  return buffer
}

/** Linear resample of an interleaved buffer. */
export function resample(decoded, targetRate) {
  const { sampleRate, channels, samples } = decoded
  if (sampleRate === targetRate) return decoded
  const frames = Math.floor(samples.length / channels)
  const ratio = targetRate / sampleRate
  const outFrames = Math.max(1, Math.round(frames * ratio))
  const out = new Float32Array(outFrames * channels)
  for (let frame = 0; frame < outFrames; frame += 1) {
    const src = frame / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(frames - 1, i0 + 1)
    const frac = src - i0
    for (let c = 0; c < channels; c += 1) {
      const a = samples[i0 * channels + c] ?? 0
      const b = samples[i1 * channels + c] ?? 0
      out[frame * channels + c] = a + (b - a) * frac
    }
  }
  return { ...decoded, sampleRate: targetRate, samples: out }
}

/** Mono view (average across channels). */
export function toMono(decoded) {
  const { sampleRate, channels, samples } = decoded
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += samples[frame * channels + c] ?? 0
    mono[frame] = sum / channels
  }
  return { sampleRate, channels: 1, samples: mono }
}

export function rms(decoded) {
  const { samples } = decoded
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

export function peak(decoded) {
  const { samples } = decoded
  let max = 0
  for (let i = 0; i < samples.length; i += 1) max = Math.max(max, Math.abs(samples[i]))
  return max
}

/**
 * Mix the converted vocal (centred, mono) over the instrumental bed.
 *
 * @param {object} options
 * @param {ReturnType<typeof decodeWav>} options.instrumental
 * @param {ReturnType<typeof decodeWav>} options.vocal          converted vocal
 * @param {ReturnType<typeof decodeWav>} [options.vocalSource]   pre-conversion vocal, for loudness match
 * @param {number} [options.targetPeak] default -1 dBFS
 * @returns {ReturnType<typeof decodeWav>}
 */
export function mixCover({ instrumental, vocal, vocalSource, targetPeak = 0.891 }) {
  const bed = instrumental
  const v = toMono(resample(vocal, bed.sampleRate))
  let gain = 1
  if (vocalSource) {
    const ref = rms(toMono(resample(vocalSource, bed.sampleRate)))
    const current = rms(v)
    if (ref > 1e-6 && current > 1e-6) gain = ref / current
  }
  const frames = Math.min(Math.floor(bed.samples.length / bed.channels), v.samples.length)
  const channels = bed.channels
  const out = new Float32Array(frames * channels)
  for (let frame = 0; frame < frames; frame += 1) {
    const voice = v.samples[frame] * gain
    for (let c = 0; c < channels; c += 1) {
      out[frame * channels + c] = (bed.samples[frame * channels + c] ?? 0) + voice
    }
  }
  const mixed = { sampleRate: bed.sampleRate, channels, bits: 24, float: false, samples: out }
  const high = peak(mixed)
  if (high > 1e-6) {
    const scale = targetPeak / high
    for (let i = 0; i < out.length; i += 1) out[i] *= scale
  }
  return mixed
}

/** Run ffmpeg if it is available; resolves false instead of throwing. */
export function ffmpeg(bin, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(String(bin || 'ffmpeg'), args, { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(false)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}
