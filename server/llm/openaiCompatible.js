/**
 * Shared OpenAI Chat Completions HTTP client.
 * Authorization Bearer only when apiKey is a non-empty string.
 */

import { joinBaseUrl } from './url.js'
import { requireNonEmptyText, validateMessages } from './types.js'

export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 // 2 MiB

/**
 * @param {Response} res
 * @param {number} maxBytes
 */
async function readBodyLimited(res, maxBytes) {
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) {
    throw Object.assign(new Error(`response exceeds ${maxBytes} bytes`), { code: 'RESPONSE_TOO_LARGE' })
  }
  return buf.toString('utf8')
}

/**
 * @param {{
 *   baseUrl: string,
 *   chatPath?: string,
 *   apiKey?: string|null,
 *   model: string,
 *   messages: import('./types.js').ChatMessage[],
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   maxResponseBytes?: number,
 *   fetchImpl?: typeof fetch,
 * }} opts
 */
export async function chatCompletions(opts) {
  const {
    baseUrl,
    chatPath = '/chat/completions',
    apiKey = null,
    model,
    messages,
    timeoutMs,
    signal: outerSignal,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
  } = opts

  const validated = validateMessages(messages)
  if (!model || typeof model !== 'string' || !model.trim()) {
    throw Object.assign(new Error('model is required'), { code: 'INVALID_INPUT' })
  }

  const url = joinBaseUrl(baseUrl, chatPath)
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key) headers.Authorization = `Bearer ${key}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const onOuterAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model.trim(), messages: validated, stream: false }),
      signal: controller.signal,
    })

    const textBody = await readBodyLimited(res, maxResponseBytes)

    if (!res.ok) {
      const code = `HTTP_${res.status}`
      throw Object.assign(new Error(`HTTP ${res.status}`), { code, status: res.status })
    }

    let data
    try {
      data = JSON.parse(textBody)
    } catch {
      throw Object.assign(new Error('response is not JSON'), { code: 'INVALID_JSON' })
    }

    const content = data?.choices?.[0]?.message?.content
    // Do not use reasoning_content as the reply
    if (typeof content !== 'string') {
      throw Object.assign(new Error('missing choices[0].message.content'), { code: 'INVALID_JSON' })
    }
    const text = requireNonEmptyText(content)
    return { text, usage: data.usage && typeof data.usage === 'object' ? data.usage : undefined }
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw Object.assign(new Error('request timed out'), { code: 'TIMEOUT' })
    }
    if (err && err.code) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: 'UNREACHABLE' })
    }
    throw Object.assign(new Error(msg), { code: 'HTTP_ERROR' })
  } finally {
    clearTimeout(timer)
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * GET with timeout and size limit (health / model list).
 * @param {{ url: string, apiKey?: string|null, timeoutMs: number, maxResponseBytes?: number, fetchImpl?: typeof fetch, signal?: AbortSignal }} opts
 */
export async function fetchJsonLimited(opts) {
  const {
    url,
    apiKey = null,
    timeoutMs,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    signal: outerSignal,
  } = opts

  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' }
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key) headers.Authorization = `Bearer ${key}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const onOuterAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }

  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const textBody = await readBodyLimited(res, maxResponseBytes)
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}`, status: res.status })
    }
    try {
      return { status: res.status, data: JSON.parse(textBody) }
    } catch {
      throw Object.assign(new Error('response is not JSON'), { code: 'INVALID_JSON' })
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw Object.assign(new Error('request timed out'), { code: 'TIMEOUT' })
    }
    if (err && err.code) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: 'UNREACHABLE' })
    }
    throw Object.assign(new Error(msg), { code: 'HTTP_ERROR' })
  } finally {
    clearTimeout(timer)
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
  }
}
