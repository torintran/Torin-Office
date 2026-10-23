/**
 * URL helpers for OpenAI-compatible LLM endpoints.
 * Does not auto-append /v1 — callers put that in the preset baseUrl when needed.
 */

/**
 * Strip trailing slashes from a base URL.
 * @param {string} base
 */
export function stripTrailingSlashes(base) {
  return String(base).replace(/\/+$/, '')
}

/**
 * Join base URL and path without double slashes or auto-/v1.
 * @param {string} base
 * @param {string} path  must start with /
 */
export function joinBaseUrl(base, path) {
  const b = stripTrailingSlashes(base)
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

const API_KEY_ENV_RE = /^[A-Z_][A-Z0-9_]*$/

/**
 * @param {unknown} name
 * @returns {string|null} null when unset / null; throws on invalid
 */
export function validateApiKeyEnv(name) {
  if (name === null || name === undefined) return null
  if (typeof name !== 'string') {
    throw Object.assign(new Error('apiKeyEnv must be a string or null'), { code: 'INVALID_CONFIG' })
  }
  const t = name.trim()
  if (!t) {
    throw Object.assign(new Error('apiKeyEnv must not be empty'), { code: 'INVALID_CONFIG' })
  }
  if (!API_KEY_ENV_RE.test(t)) {
    throw Object.assign(new Error('apiKeyEnv must match ^[A-Z_][A-Z0-9_]*$'), { code: 'INVALID_CONFIG' })
  }
  return t
}

/**
 * Validate and normalize a provider baseUrl.
 * Rejects userinfo, fragment, and non-empty query.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function validateBaseUrl(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') {
    throw Object.assign(new Error('baseUrl must be a string or null'), { code: 'INVALID_CONFIG' })
  }
  const t = raw.trim()
  if (!t) {
    throw Object.assign(new Error('baseUrl must not be empty'), { code: 'INVALID_CONFIG' })
  }
  let u
  try {
    u = new URL(t)
  } catch {
    throw Object.assign(new Error('baseUrl is not a valid URL'), { code: 'INVALID_CONFIG' })
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('baseUrl scheme must be http or https'), { code: 'INVALID_CONFIG' })
  }
  if (u.username || u.password) {
    throw Object.assign(new Error('baseUrl must not include username or password'), { code: 'INVALID_CONFIG' })
  }
  if (u.hash) {
    throw Object.assign(new Error('baseUrl must not include a fragment'), { code: 'INVALID_CONFIG' })
  }
  if (u.search) {
    throw Object.assign(new Error('baseUrl must not include a query string'), { code: 'INVALID_CONFIG' })
  }
  if (!u.hostname) {
    throw Object.assign(new Error('baseUrl must include a hostname'), { code: 'INVALID_CONFIG' })
  }
  // Rebuild without trailing slash on pathname-only bases that are just origin+path
  const path = u.pathname === '/' ? '' : stripTrailingSlashes(u.pathname)
  const port = u.port ? `:${u.port}` : ''
  return `${u.protocol}//${u.hostname}${port}${path}`
}
