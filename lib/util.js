/**
 * Small shared helpers for the Voice Studio host half.
 *
 * No third-party dependencies: the plugin is installed straight from a
 * directory, so everything here is Node built-ins only.
 */
import { createReadStream, mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync, statSync, existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

export function mimeOf(filePath) {
  return MIME[extname(String(filePath)).toLowerCase()] || 'application/octet-stream'
}

export function uid(prefix = '') {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function homePath(...parts) {
  return join(homedir(), ...parts)
}

/** UTF-8 safe truncation for a model-visible error string. */
export function brief(value, max = 400) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

/** Read a request body with a hard cap; rejects instead of buffering forever. */
export function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail(Object.assign(new Error(`payload exceeds ${maxBytes} bytes`), { code: 'TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

export async function readJson(req, maxBytes = 8 * 1024 * 1024) {
  const raw = await readBody(req, maxBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' })
  }
}

/** Read a JSON file, returning `fallback` for anything unreadable. */
export async function readJsonFile(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

/** Atomic whole-file JSON write: temp + fsync + rename (same semantics as DSH JSON units). */
export function writeJsonAtomicSync(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp${process.pid}${Math.floor(Math.random() * 1e6)}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch {
    writeSync(openSync(file, 'w'), JSON.stringify(value))
  }
}

export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** Serve a local file with single-range support (audio seeking in the page). */
export function streamFile(req, res, filePath) {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    sendJson(res, 404, { error: 'file not found' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'not a file' })
    return
  }
  const type = mimeOf(filePath)
  const range = req.headers.range
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(String(range))
    if (match) {
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end)
        end = stat.size - 1
      }
      start = start === null ? 0 : start
      end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1)
      if (start > end || start >= stat.size) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${stat.size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`)
      res.setHeader('accept-ranges', 'bytes')
      res.setHeader('content-type', type)
      res.setHeader('content-length', String(end - start + 1))
      createReadStream(filePath, { start, end }).pipe(res)
      return
    }
  }
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('content-length', String(stat.size))
  res.setHeader('accept-ranges', 'bytes')
  createReadStream(filePath).pipe(res)
}

/** Spawn a child process, collecting stdout/stderr with a hard timeout. */
export function run(cmd, args, options = {}) {
  const { cwd, env, timeoutMs = 15 * 60 * 1000, input } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const err = []
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(Object.assign(new Error(`process timed out after ${timeoutMs} ms: ${cmd}`), {
        code: 'TIMEOUT',
        stderr: Buffer.concat(err).toString('utf8').slice(-2000),
      }))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    if (input !== undefined) {
      try {
        child.stdin.end(input)
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
    }
  })
}

/** fetch with timeout + JSON decode; throws an Error carrying status and body. */
export async function fetchJson(url, options = {}) {
  const { timeoutMs = 120000, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = text
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status} ${url}`), {
        status: response.status,
        body: typeof body === 'string' ? body.slice(0, 800) : body,
      })
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** fetch that returns raw bytes (audio endpoints). */
export async function fetchBytes(url, options = {}) {
  const { timeoutMs = 300000, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw Object.assign(new Error(`HTTP ${response.status} ${url}: ${brief(text, 300)}`), {
        status: response.status,
      })
    }
    const type = response.headers.get('content-type') || ''
    return { bytes: Buffer.from(await response.arrayBuffer()), type }
  } finally {
    clearTimeout(timer)
  }
}

/** A reachability probe that never throws. */
export async function probe(url, timeoutMs = 4000) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, ms: Date.now() - started, head: text.slice(0, 400) }
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function removeFile(file) {
  try {
    await unlink(file)
  } catch {
    /* ignore */
  }
}

export { existsSync, join, dirname, extname, readFile, writeFile }
