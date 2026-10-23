/**
 * Generic OpenAI-compatible Chat Completions endpoint.
 * Requires user-provided baseUrl + model. API key optional (local servers).
 */

import { chatCompletions, fetchJsonLimited } from '../openaiCompatible.js'
import { resolveApiKey, missingKeyHint } from '../envKeys.js'
import { unknownHealth } from '../types.js'
import { joinBaseUrl } from '../url.js'

export const metadata = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  needsApiKey: false, // optional — many local servers need none
  defaultApiKeyEnv: 'OPENAI_API_KEY',
  defaultBaseUrl: null, // user must set
  chatPath: '/chat/completions',
  defaultModel: null, // user must set
  suggestedModels: [],
  supportsListModels: true,
}

/**
 * @param {{ messages, model, timeoutMs, signal?, baseUrl?, apiKeyEnv?, apiKey?, fetchImpl? }} req
 */
export async function generate(req) {
  if (!req.baseUrl) {
    throw Object.assign(new Error('baseUrl is required for openai-compatible'), { code: 'INVALID_CONFIG' })
  }
  if (!req.model || !String(req.model).trim()) {
    throw Object.assign(new Error('model is required for openai-compatible'), { code: 'INVALID_CONFIG' })
  }
  const apiKeyEnv = req.apiKeyEnv || metadata.defaultApiKeyEnv
  const apiKey = req.apiKey ?? (apiKeyEnv ? resolveApiKey(apiKeyEnv, { officeHome: req.officeHome }) : null)
  return chatCompletions({
    baseUrl: req.baseUrl,
    chatPath: metadata.chatPath,
    apiKey,
    model: req.model,
    messages: req.messages,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    fetchImpl: req.fetchImpl,
  })
}

/**
 * @param {{ baseUrl, apiKeyEnv?, timeoutMs?, fetchImpl? }} opts
 */
export async function listModels(opts = {}) {
  if (!opts.baseUrl) {
    throw Object.assign(new Error('baseUrl is required'), { code: 'INVALID_CONFIG' })
  }
  const apiKeyEnv = opts.apiKeyEnv || metadata.defaultApiKeyEnv
  const apiKey = apiKeyEnv ? resolveApiKey(apiKeyEnv, { officeHome: opts.officeHome }) : null
  const { data } = await fetchJsonLimited({
    url: joinBaseUrl(opts.baseUrl, '/models'),
    apiKey,
    timeoutMs: opts.timeoutMs ?? 10000,
    fetchImpl: opts.fetchImpl,
  })
  const list = Array.isArray(data?.data) ? data.data : []
  return list.map((m) => m?.id).filter((id) => typeof id === 'string' && id)
}

/**
 * @param {{ baseUrl?, model?, apiKeyEnv?, timeoutMs?, probe?: 'generate'|'light', fetchImpl? }} opts
 */
export async function health(opts = {}) {
  if (!opts.baseUrl) {
    return unknownHealth({
      configured: false,
      ready: false,
      detail: 'baseUrl is required for openai-compatible',
    })
  }
  if (!opts.model) {
    return unknownHealth({
      configured: false,
      ready: false,
      detail: 'model is required for openai-compatible',
    })
  }

  const apiKeyEnv = opts.apiKeyEnv || metadata.defaultApiKeyEnv
  const apiKey = apiKeyEnv ? resolveApiKey(apiKeyEnv, { officeHome: opts.officeHome }) : null
  const timeoutMs = opts.timeoutMs ?? 10000

  if (opts.probe === 'generate') {
    try {
      await generate({
        messages: [
          { role: 'system', content: 'Reply with exactly: ok' },
          { role: 'user', content: 'ping' },
        ],
        model: opts.model,
        timeoutMs,
        baseUrl: opts.baseUrl,
        apiKeyEnv,
        apiKey,
        officeHome: opts.officeHome,
        fetchImpl: opts.fetchImpl,
      })
      return {
        configured: true,
        reachable: true,
        authenticated: apiKey ? true : 'unknown',
        modelAvailable: true,
        ready: true,
        detail: 'Generate probe succeeded',
        mayConsumeTokens: true,
        mayConsumeLocalResources: true,
      }
    } catch (err) {
      if (err.code === 'HTTP_401') {
        return unknownHealth({
          configured: true,
          reachable: true,
          authenticated: false,
          ready: false,
          detail: 'Unauthorized',
          hint: apiKeyEnv ? missingKeyHint(apiKeyEnv) : undefined,
          mayConsumeTokens: true,
        })
      }
      return unknownHealth({
        configured: true,
        reachable: err.code === 'UNREACHABLE' ? false : 'unknown',
        ready: false,
        detail: err.message,
        mayConsumeTokens: true,
      })
    }
  }

  // Light: try /models — success does not prove Chat Completions
  try {
    const names = await listModels({
      baseUrl: opts.baseUrl,
      apiKeyEnv,
      timeoutMs,
      fetchImpl: opts.fetchImpl,
    })
    const has = names.includes(opts.model)
    return {
      configured: true,
      reachable: true,
      authenticated: apiKey ? true : 'unknown',
      modelAvailable: names.length === 0 ? 'unknown' : has,
      ready: 'unknown', // do not claim Chat Completions works from /models alone
      detail: names.length
        ? `Listed ${names.length} model(s); Chat Completions not probed`
        : 'Endpoint responded; model list empty — Chat Completions unknown',
      mayConsumeTokens: false,
    }
  } catch (err) {
    if (err.code === 'HTTP_401') {
      return unknownHealth({
        configured: true,
        reachable: true,
        authenticated: false,
        ready: false,
        detail: 'Unauthorized',
        hint: apiKeyEnv ? missingKeyHint(apiKeyEnv) : undefined,
      })
    }
    return unknownHealth({
      configured: true,
      reachable: err.code === 'UNREACHABLE' || err.code === 'TIMEOUT' ? false : 'unknown',
      ready: 'unknown',
      detail: err.message,
    })
  }
}

export default { id: metadata.id, metadata, generate, listModels, health }
