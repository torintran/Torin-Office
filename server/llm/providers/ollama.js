/**
 * Ollama OpenAI-compatible endpoint (default http://127.0.0.1:11434/v1).
 * No Authorization unless a key is configured.
 */

import { chatCompletions, fetchJsonLimited } from '../openaiCompatible.js'
import { resolveApiKey } from '../envKeys.js'
import { unknownHealth } from '../types.js'
import { joinBaseUrl, stripTrailingSlashes } from '../url.js'

export const metadata = {
  id: 'ollama',
  label: 'Ollama',
  needsApiKey: false,
  defaultApiKeyEnv: null,
  defaultBaseUrl: 'http://127.0.0.1:11434/v1',
  chatPath: '/chat/completions',
  defaultModel: 'llama3.2',
  suggestedModels: [],
  supportsListModels: true,
}

/** Origin without /v1 for native /api/tags */
function ollamaNativeBase(baseUrl) {
  const b = stripTrailingSlashes(baseUrl || metadata.defaultBaseUrl)
  return b.replace(/\/v1$/i, '')
}

/**
 * @param {{ messages, model, timeoutMs, signal?, baseUrl?, apiKeyEnv?, apiKey?, fetchImpl? }} req
 */
export async function generate(req) {
  const baseUrl = req.baseUrl || metadata.defaultBaseUrl
  const apiKeyEnv = req.apiKeyEnv || null
  const apiKey = req.apiKey ?? (apiKeyEnv ? resolveApiKey(apiKeyEnv) : null)
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
 * @param {{ baseUrl?, timeoutMs?, fetchImpl? }} opts
 * @returns {Promise<string[]>}
 */
export async function listModels(opts = {}) {
  const baseUrl = opts.baseUrl || metadata.defaultBaseUrl
  const timeoutMs = opts.timeoutMs ?? 10000
  const tagsUrl = joinBaseUrl(ollamaNativeBase(baseUrl), '/api/tags')
  const { data } = await fetchJsonLimited({
    url: tagsUrl,
    apiKey: null,
    timeoutMs,
    fetchImpl: opts.fetchImpl,
  })
  const models = Array.isArray(data?.models) ? data.models : []
  return models.map((m) => m?.name || m?.model).filter((n) => typeof n === 'string' && n)
}

/**
 * @param {{ baseUrl?, model?, timeoutMs?, probe?: 'generate'|'light', apiKeyEnv?, fetchImpl? }} opts
 */
export async function health(opts = {}) {
  const baseUrl = opts.baseUrl || metadata.defaultBaseUrl
  const timeoutMs = opts.timeoutMs ?? 10000
  const model = opts.model || metadata.defaultModel

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
        apiKeyEnv: opts.apiKeyEnv,
        fetchImpl: opts.fetchImpl,
      })
      return {
        configured: true,
        reachable: true,
        authenticated: 'unknown',
        modelAvailable: true,
        ready: true,
        detail: `Generate probe succeeded for ${model}`,
        mayConsumeTokens: false,
        mayConsumeLocalResources: true,
      }
    } catch (err) {
      return unknownHealth({
        configured: true,
        reachable: err.code === 'UNREACHABLE' || err.code === 'TIMEOUT' ? false : true,
        modelAvailable: false,
        ready: false,
        detail: err.message,
        mayConsumeLocalResources: true,
      })
    }
  }

  try {
    const names = await listModels({ baseUrl, timeoutMs, fetchImpl: opts.fetchImpl })
    const has = names.includes(model) || names.some((n) => n === model || n.startsWith(`${model}:`))
    return {
      configured: true,
      reachable: true,
      authenticated: 'unknown',
      modelAvailable: names.length === 0 ? 'unknown' : has,
      ready: has ? true : names.length === 0 ? 'unknown' : false,
      detail: names.length
        ? `Ollama has ${names.length} model(s)${has ? `; ${model} available` : `; ${model} not pulled`}`
        : 'Ollama reachable but no models pulled',
      mayConsumeTokens: false,
      mayConsumeLocalResources: false,
    }
  } catch (err) {
    return unknownHealth({
      configured: true,
      reachable: false,
      ready: false,
      detail: err.message || 'Ollama unreachable',
      hint: 'Start Ollama (ollama serve) and pull a model, e.g. ollama pull llama3.2',
      mayConsumeLocalResources: false,
    })
  }
}

export default { id: metadata.id, metadata, generate, listModels, health }
