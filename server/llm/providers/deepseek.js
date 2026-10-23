/**
 * DeepSeek Chat Completions (OpenAI-compatible).
 * Default model from official docs: deepseek-flash (not deepseek-chat).
 */

import { chatCompletions, fetchJsonLimited } from '../openaiCompatible.js'
import { resolveApiKey, missingKeyHint } from '../envKeys.js'
import { unknownHealth } from '../types.js'
import { joinBaseUrl } from '../url.js'

export const metadata = {
  id: 'deepseek',
  label: 'DeepSeek',
  needsApiKey: true,
  defaultApiKeyEnv: 'DEEPSEEK_API_KEY',
  defaultBaseUrl: 'https://api.deepseek.com',
  chatPath: '/chat/completions',
  defaultModel: 'deepseek-flash',
  suggestedModels: ['deepseek-flash', 'deepseek-v4-pro'],
  supportsListModels: false,
}

/**
 * @param {{ messages, model, timeoutMs, signal?, baseUrl?, apiKeyEnv?, apiKey?, fetchImpl? }} req
 */
export async function generate(req) {
  const baseUrl = req.baseUrl || metadata.defaultBaseUrl
  const apiKeyEnv = req.apiKeyEnv || metadata.defaultApiKeyEnv
  const apiKey = req.apiKey ?? resolveApiKey(apiKeyEnv, { officeHome: req.officeHome })
  if (!apiKey) {
    throw Object.assign(new Error(missingKeyHint(apiKeyEnv)), {
      code: 'MISSING_KEY',
      hint: missingKeyHint(apiKeyEnv),
    })
  }
  return chatCompletions({
    baseUrl,
    chatPath: metadata.chatPath,
    apiKey,
    model: req.model || metadata.defaultModel,
    messages: req.messages,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    fetchImpl: req.fetchImpl,
  })
}

/**
 * Light health: key present + optional models list / tiny probe without generate unless requested.
 * @param {{ baseUrl?, apiKeyEnv?, model?, timeoutMs?, probe?: 'generate'|'light', fetchImpl? }} opts
 */
export async function health(opts = {}) {
  const baseUrl = opts.baseUrl || metadata.defaultBaseUrl
  const apiKeyEnv = opts.apiKeyEnv || metadata.defaultApiKeyEnv
  const apiKey = resolveApiKey(apiKeyEnv, { officeHome: opts.officeHome })
  const timeoutMs = opts.timeoutMs ?? 10000
  const model = opts.model || metadata.defaultModel

  if (!apiKey) {
    return unknownHealth({
      configured: false,
      reachable: 'unknown',
      authenticated: false,
      modelAvailable: 'unknown',
      ready: false,
      detail: `API key env ${apiKeyEnv} is not set`,
      hint: missingKeyHint(apiKeyEnv),
      mayConsumeTokens: false,
    })
  }

  if (opts.probe === 'generate') {
    try {
      await generate({
        messages: [
          { role: 'system', content: 'Reply with exactly: ok' },
          { role: 'user', content: 'ping' },
        ],
        model,
        timeoutMs,
        baseUrl,
        apiKeyEnv,
        apiKey,
        officeHome: opts.officeHome,
        fetchImpl: opts.fetchImpl,
      })
      return {
        configured: true,
        reachable: true,
        authenticated: true,
        modelAvailable: true,
        ready: true,
        detail: `Generate probe succeeded for ${model}`,
        mayConsumeTokens: true,
      }
    } catch (err) {
      return mapHttpHealth(err, { configured: true, mayConsumeTokens: true })
    }
  }

  // Light: try GET /models if available; otherwise leave model/ready unknown
  try {
    const { status, data } = await fetchJsonLimited({
      url: joinBaseUrl(baseUrl, '/models'),
      apiKey,
      timeoutMs,
      fetchImpl: opts.fetchImpl,
    })
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => m?.id).filter(Boolean)
      : []
    const modelOk = ids.length === 0 ? 'unknown' : ids.includes(model)
    return {
      configured: true,
      reachable: true,
      authenticated: status === 200,
      modelAvailable: modelOk === true ? true : modelOk === false ? false : 'unknown',
      ready: modelOk === true ? true : 'unknown',
      detail: ids.length ? `Listed ${ids.length} model(s)` : 'Authenticated; model list empty or unsupported',
      mayConsumeTokens: false,
    }
  } catch (err) {
    // 404 on /models is common — reachable/auth unknown vs failed
    if (err.status === 401 || err.code === 'HTTP_401') {
      return unknownHealth({
        configured: true,
        reachable: true,
        authenticated: false,
        ready: false,
        detail: 'Unauthorized — check API key',
        hint: missingKeyHint(apiKeyEnv),
        mayConsumeTokens: false,
      })
    }
    if (err.code === 'UNREACHABLE' || err.code === 'TIMEOUT') {
      return unknownHealth({
        configured: true,
        reachable: false,
        detail: err.message,
        mayConsumeTokens: false,
      })
    }
    // Key present; endpoint may not support /models
    return unknownHealth({
      configured: true,
      reachable: 'unknown',
      authenticated: 'unknown',
      modelAvailable: 'unknown',
      ready: 'unknown',
      detail: `Key present; light check inconclusive (${err.code || err.message})`,
      mayConsumeTokens: false,
    })
  }
}

function mapHttpHealth(err, extra = {}) {
  const code = err.code || 'HTTP_ERROR'
  if (code === 'MISSING_KEY') {
    return unknownHealth({
      configured: false,
      authenticated: false,
      ready: false,
      detail: err.message,
      hint: err.hint,
      ...extra,
    })
  }
  if (code === 'HTTP_401') {
    return unknownHealth({
      configured: true,
      reachable: true,
      authenticated: false,
      ready: false,
      detail: 'Unauthorized',
      ...extra,
    })
  }
  if (code === 'UNREACHABLE' || code === 'TIMEOUT') {
    return unknownHealth({
      configured: true,
      reachable: false,
      detail: err.message,
      ...extra,
    })
  }
  return unknownHealth({
    configured: true,
    reachable: true,
    authenticated: 'unknown',
    modelAvailable: false,
    ready: false,
    detail: err.message,
    ...extra,
  })
}

export default { id: metadata.id, metadata, generate, health }
