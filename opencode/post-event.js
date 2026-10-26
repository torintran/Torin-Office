/**
 * POST /event to Agent Office with HMAC request signing (same scheme as
 * hooks/agent-tracker.sh) or Bearer token fallback.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function officeHome() {
  return process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
}

export function eventUrl() {
  if (process.env.AGENT_OFFICE_EVENT_URL) return process.env.AGENT_OFFICE_EVENT_URL
  const port = process.env.AGENT_OFFICE_PORT || '3334'
  return `http://127.0.0.1:${port}/event`
}

export function readToken() {
  const file = join(officeHome(), 'auth-token')
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function answerPermissionsEnabled() {
  return existsSync(join(officeHome(), 'answer-permissions'))
}

function urlPath(url) {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    const rest = String(url).split('://').pop() || ''
    const i = rest.indexOf('/')
    return i >= 0 ? rest.slice(i) : '/'
  }
}

export function signRequest(token, method, path, timestamp, body) {
  const h = createHmac('sha256', token)
  h.update(`${method}\n${path}\n${timestamp}\n`)
  h.update(body || '')
  return h.digest('hex')
}

/**
 * @param {object} event
 * @param {{ token?: string, url?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
export async function postEvent(event, opts = {}) {
  const url = opts.url || eventUrl()
  const token = opts.token !== undefined ? opts.token : readToken()
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const body = JSON.stringify(event)
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    const ts = String(Date.now())
    const path = urlPath(url)
    headers['x-office-timestamp'] = ts
    headers['x-office-signature'] = signRequest(token, 'POST', path, ts, body)
  }
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body })
    let json = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, body: json }
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err?.message || err) } }
  }
}

/**
 * Long-poll GET /permission/:id until a terminal status (or timeout).
 * @returns {Promise<'allow'|'deny'|null>}
 */
export async function pollPermissionDecision(permissionId, opts = {}) {
  const token = opts.token !== undefined ? opts.token : readToken()
  if (!token || !permissionId) return null
  const base = (opts.url || eventUrl()).replace(/\/event\/?$/, '')
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)

  while (Date.now() < deadline) {
    const wait = Math.min(25, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)))
    const url = `${base}/permission/${encodeURIComponent(permissionId)}?wait=${wait}`
    const ts = String(Date.now())
    const path = urlPath(url)
    const headers = {
      'x-office-timestamp': ts,
      'x-office-signature': signRequest(token, 'GET', path, ts, ''),
    }
    try {
      const res = await fetchImpl(url, { method: 'GET', headers })
      if (!res.ok) return null
      const data = await res.json()
      const status = data?.status
      if (status === 'allowed') return 'allow'
      if (status === 'denied') return 'deny'
      if (status === 'resolved_elsewhere' || status === 'expired') return null
      // still pending — loop
    } catch {
      return null
    }
  }
  return null
}

export function newNonce() {
  return randomBytes(16).toString('hex')
}
