// publik-telemetry.cjs — publik telemetry v1 client for Node 18+ and the Electron main process.
// It sends two usage events to publik: app_opened and active_session. Nothing else.
//
// How to add it:
//   1. Copy this file into your app. It has no dependencies.
//   2. const telemetry = require('./publik-telemetry.cjs')
//   3. telemetry.start('your-slug', app.getVersion())   // optional 3rd argument: () => publikKeyOrNull
//
// Opt-outs: DO_NOT_TRACK=1, PUBLIK_TELEMETRY=0, or "usage": false in <publik dir>/consent.json.
// Docs: https://publikhq.com/skills/telemetry.md
// Public domain (CC0). Copy it into your app.
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const ENDPOINT = 'https://publikhq.com/api/v1/telemetry'
const TIMEOUT_MS = 5000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i // version 4: the server takes no other kind
const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch]

let started = false
let timer = null
let idPromise = null // one install ID for the whole run
const inFlight = new Set()

function env(name) {
  return String(process.env[name] || '').trim()
}

// <publik dir>: the folder that all publik apps share on this computer account.
// A folder from the environment counts only when it is an absolute path. If no home folder is found,
// this function throws and the client sends nothing.
function publikDir() {
  const fromEnv = (name) => (path.isAbsolute(process.env[name] || '') ? process.env[name] : null)
  const home = (...parts) => {
    const dir = os.homedir()
    if (!path.isAbsolute(dir)) throw new Error('no home folder')
    return path.join(dir, ...parts)
  }
  if (process.platform === 'darwin') return path.join(home('Library', 'Application Support'), 'publik')
  if (process.platform === 'win32') return path.join(fromEnv('LOCALAPPDATA') || home('AppData', 'Local'), 'publik')
  return path.join(fromEnv('XDG_CONFIG_HOME') || home('.config'), 'publik')
}

// The text of a small file: UTF-8, UTF-16 or UTF-32, with or without a byte-order mark.
// Notepad and PowerShell on Windows save UTF-16, or UTF-8 with a mark.
function decode(raw) {
  const [a, b, c, d] = raw
  const zero = (...at) => at.every((i) => raw[i] === 0)
  let size = 1 // bytes for each character
  let big = false // big-endian
  if ((a === 0xff && b === 0xfe && zero(2, 3)) || (a && zero(1, 2, 3))) size = 4
  else if (zero(0, 1) && ((c === 0xfe && d === 0xff) || (c === 0 && d))) [size, big] = [4, true]
  else if ((a === 0xff && b === 0xfe) || (a && b === 0)) size = 2
  else if ((a === 0xfe && b === 0xff) || (a === 0 && b)) [size, big] = [2, true]
  if (size === 1) return raw.toString('utf8').replace(/^\uFEFF/, '')
  const read = { 2: big ? 'readUInt16BE' : 'readUInt16LE', 4: big ? 'readUInt32BE' : 'readUInt32LE' }[size]
  let text = ''
  for (let i = 0; i + size <= raw.length; i += size) text += String.fromCodePoint(raw[read](i))
  return text.replace(/^\uFEFF/, '')
}

async function readJson(file) {
  try {
    const data = JSON.parse(decode(await fs.readFile(file)))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

// Opt-out. The client checks it before each send, before it touches telemetry.json or the network.
async function optedOut(dir) {
  const dnt = env('DO_NOT_TRACK').toLowerCase()
  if (dnt !== '' && dnt !== '0' && dnt !== 'false') return true
  if (['0', 'false', 'off'].includes(env('PUBLIK_TELEMETRY').toLowerCase())) return true
  return (await readJson(path.join(dir, 'consent.json'))).usage === false
}

// What telemetry.json holds. state: 'ok' (with the ID), 'missing', 'unreadable' (the read failed)
// or 'damaged' (the read worked and the content is not valid).
async function savedId(file) {
  let raw
  try {
    raw = await fs.readFile(file)
  } catch (err) {
    return { state: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  try {
    const id = JSON.parse(decode(raw)).install_id
    if (typeof id === 'string' && UUID.test(id)) return { state: 'ok', id: id.toLowerCase() }
  } catch {}
  return { state: 'damaged' }
}

// Saves a new telemetry.json in one step: the full text goes to a temp file, then a hard link gives it
// the real name. An app that starts at the same time sees no file or the full file, never an empty file.
// Result: 'saved', 'exists' (another app saved its file first) or 'failed'.
async function saveNew(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 })
    try {
      await fs.link(temp, file)
    } catch (err) {
      if (err && err.code === 'EEXIST') return 'exists'
      await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }) // no hard links on this disk: plain exclusive create
    }
    return 'saved'
  } catch (err) {
    return err && err.code === 'EEXIST' ? 'exists' : 'failed'
  } finally {
    await fs.unlink(temp).catch(() => {})
  }
}

// Install ID: one random UUID v4 per computer account, in <publik dir>/telemetry.json (mode 0600).
async function loadInstallId(dir) {
  const file = path.join(dir, 'telemetry.json')
  const fresh = crypto.randomUUID() // if the file cannot be read or saved, this ID lasts for this run only
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const text = JSON.stringify({ install_id: fresh, created_at: created }) + '\n'
  let replaced = false
  for (let round = 0; round < 3; round++) {
    let saved = await savedId(file)
    if (saved.state === 'damaged' && !replaced) {
      await new Promise((resolve) => setTimeout(resolve, 100)) // an app with an old client can be in the middle of its save
      saved = await savedId(file)
      if (saved.state === 'damaged') {
        replaced = true
        try {
          await fs.unlink(file) // the content is not valid: replace the file once
        } catch (err) {
          if (!err || err.code !== 'ENOENT') return fresh
        }
        saved = { state: 'missing' }
      }
    }
    if (saved.state === 'ok') return saved.id
    if (saved.state !== 'missing') return fresh // the read failed: keep the file
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    } catch {
      return fresh
    }
    if ((await saveNew(file, text)) !== 'exists') return fresh
    // another publik app saved its ID first: the next round reads that one
  }
  return fresh
}

function installId(dir) {
  if (!idPromise) idPromise = loadInstallId(dir).catch(() => crypto.randomUUID())
  return idPromise
}

// Key order: the app's own publik key, then PUBLIK_API_KEY, then <publik dir>/apps/<slug>.json.
// Only a publik key (pk_...) is sent. A provider key such as sk-... is never sent.
async function publikKey(dir, slug, keyProvider) {
  const sources = [
    () => (typeof keyProvider === 'function' ? keyProvider() : null),
    () => process.env.PUBLIK_API_KEY,
    async () => (/^[a-z0-9][a-z0-9._-]*$/.test(slug) ? (await readJson(path.join(dir, 'apps', slug + '.json'))).key : null),
  ]
  for (const source of sources) {
    try {
      const key = await source()
      if (typeof key === 'string' && /^pk_[A-Za-z0-9_-]+$/.test(key.trim())) return key.trim()
    } catch {}
  }
  return null
}

// One POST. Global fetch when present, node:https otherwise. Resolves to the HTTP status.
async function post(url, headers, body, signal) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { method: 'POST', headers, body, signal })
    if (res.body) res.body.cancel().catch(() => {})
    return res.status
  }
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const lib = require(target.protocol === 'http:' ? 'node:http' : 'node:https')
    const req = lib.request(target, { method: 'POST', headers, signal }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end(body)
  })
}

function reason(err) {
  const cause = (err && err.cause) || {}
  const code = (e) => (typeof e.code === 'string' ? e.code : '')
  return (err && (code(cause) || cause.message || code(err) || err.message)) || 'error'
}

// One attempt: no retry, 5 second limit, never throws.
async function send(event, slug, version, keyProvider) {
  const debug = env('PUBLIK_TELEMETRY_DEBUG') === '1'
  const say = (result) => {
    try {
      if (debug) process.stderr.write(`publik-telemetry: ${event} -> ${result}\n`)
    } catch {}
  }
  const ctrl = new AbortController()
  const limit = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS)
  if (limit.unref) limit.unref()
  inFlight.add(ctrl)
  try {
    if (!OS_NAME) return
    const dir = publikDir()
    if (await optedOut(dir)) return say('off (opt-out)')
    const body = { v: 1, app: slug, install_id: await installId(dir), event, app_version: version, os: OS_NAME }
    if (ARCH) body.arch = ARCH
    const headers = { 'Content-Type': 'application/json' }
    const key = await publikKey(dir, slug, keyProvider)
    if (key) headers.Authorization = 'Bearer ' + key
    if (ctrl.signal.aborted) return say('stopped')
    say(await post(env('PUBLIK_TELEMETRY_URL') || ENDPOINT, headers, JSON.stringify(body), ctrl.signal))
  } catch (err) {
    say(reason(err))
  } finally {
    clearTimeout(limit)
    inFlight.delete(ctrl)
  }
}

// The server takes 1 to 64 printable ASCII characters, with no "v" at the start and no space at an end.
function cleanVersion(value) {
  const text = String(value || '').replace(/[^\x20-\x7e]/g, '').replace(/^[vV ]+/, '')
  return text.slice(0, 64).trimEnd() || '0'
}

/**
 * Sends app_opened in the background and starts the 30-minute active_session timer.
 * A second call does nothing. keyProvider is optional: it returns the app's current
 * publik key, or nothing when the user is signed out. It can be async.
 */
function start(appSlug, appVersion, keyProvider) {
  try {
    if (started) return
    started = true
    const slug = String(appSlug || '').trim().toLowerCase()
    const version = cleanVersion(appVersion)
    const fire = (event) => {
      send(event, slug, version, keyProvider).catch(() => {})
    }
    const seconds = Number(env('PUBLIK_TELEMETRY_INTERVAL_SECONDS')) // tests only
    timer = setInterval(fire, (seconds >= 1 && seconds <= 86400 ? seconds : 1800) * 1000, 'active_session')
    if (timer.unref) timer.unref() // the timer never keeps the process alive
    setImmediate(fire, 'app_opened')
  } catch {}
}

/** Optional. Stops the timer and drops a send that is in progress. */
function stop() {
  try {
    if (timer) clearInterval(timer)
    timer = null
    for (const ctrl of inFlight) ctrl.abort(new Error('stopped'))
  } catch {}
}

module.exports = { start, stop }
