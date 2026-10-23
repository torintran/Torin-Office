/**
 * Resolve chatAi settings into a single ResolvedChatAiConfig.
 * Precedence: env overrides > settings.chatAi > provider metadata defaults.
 * Empty-string env overrides are INVALID (no silent fallback).
 */

import { getProviderMetadata, listProviderIds, listProviderMeta, resolveProvider } from './registry.js'
import { validateApiKeyEnv, validateBaseUrl } from './url.js'
import { resolveApiKey } from './envKeys.js'

export const DEFAULT_TIMEOUT_SEC = 60

/**
 * @typedef {{
 *   provider: string,
 *   model: string,
 *   baseUrl: string|null,
 *   apiKeyEnv: string|null,
 *   timeoutSec: number,
 * }} ResolvedChatAiConfig
 */

/**
 * Defaults when switching to a provider (or first boot).
 * @param {string} providerId
 * @returns {ResolvedChatAiConfig}
 */
export function defaultsForProvider(providerId) {
  const m = getProviderMetadata(providerId)
  return {
    provider: m.id,
    model: m.defaultModel || '',
    baseUrl: m.defaultBaseUrl,
    apiKeyEnv: m.defaultApiKeyEnv,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
  }
}

/**
 * Stored shape in settings.json (partial allowed).
 * @returns {{ provider: string, model: string|null, baseUrl: string|null, apiKeyEnv: string|null, timeoutSec: number }}
 */
export function defaultStoredChatAi() {
  const d = defaultsForProvider('claude-cli')
  return {
    provider: d.provider,
    model: d.model,
    baseUrl: d.baseUrl,
    apiKeyEnv: d.apiKeyEnv,
    timeoutSec: d.timeoutSec,
  }
}

/**
 * When user changes provider via POST, apply new provider defaults for related fields.
 * @param {object} prev stored chatAi
 * @param {string} newProvider
 */
export function applyProviderSwitch(prev, newProvider) {
  const d = defaultsForProvider(newProvider)
  return {
    provider: d.provider,
    model: d.model,
    baseUrl: d.baseUrl,
    apiKeyEnv: d.apiKeyEnv,
    timeoutSec: typeof prev?.timeoutSec === 'number' && prev.timeoutSec > 0
      ? prev.timeoutSec
      : d.timeoutSec,
  }
}

/**
 * Validate a stored/partial chatAi object (from POST body). Does not apply env.
 * @param {unknown} raw
 * @param {{ previous?: object, switchingProvider?: boolean }} [opts]
 */
export function normalizeStoredChatAi(raw, opts = {}) {
  if (raw === undefined || raw === null) {
    return opts.previous ? { ...opts.previous } : defaultStoredChatAi()
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('chatAi must be an object'), { code: 'INVALID_CONFIG' })
  }

  const prev = opts.previous || defaultStoredChatAi()
  let provider = raw.provider !== undefined ? raw.provider : prev.provider

  if (typeof provider !== 'string' || !listProviderIds().includes(provider)) {
    throw Object.assign(new Error(`provider must be one of: ${listProviderIds().join(', ')}`), {
      code: 'INVALID_CONFIG',
    })
  }

  const providerChanged = provider !== prev.provider
  if (providerChanged || opts.switchingProvider) {
    const switched = applyProviderSwitch(prev, provider)
    // Allow explicit overrides in the same POST for model/baseUrl/apiKeyEnv/timeout
    if (raw.model !== undefined) switched.model = coerceModel(raw.model, provider)
    if (raw.baseUrl !== undefined) switched.baseUrl = coerceBaseUrl(raw.baseUrl, provider)
    if (raw.apiKeyEnv !== undefined) switched.apiKeyEnv = coerceApiKeyEnv(raw.apiKeyEnv, provider)
    if (raw.timeoutSec !== undefined) switched.timeoutSec = coerceTimeout(raw.timeoutSec)
    return switched
  }

  const out = {
    provider,
    model: raw.model !== undefined ? coerceModel(raw.model, provider) : prev.model,
    baseUrl: raw.baseUrl !== undefined ? coerceBaseUrl(raw.baseUrl, provider) : prev.baseUrl,
    apiKeyEnv: raw.apiKeyEnv !== undefined ? coerceApiKeyEnv(raw.apiKeyEnv, provider) : prev.apiKeyEnv,
    timeoutSec: raw.timeoutSec !== undefined ? coerceTimeout(raw.timeoutSec) : (prev.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
  }
  return out
}

function coerceModel(v, providerId) {
  const m = getProviderMetadata(providerId)
  if (v === null) return m.defaultModel || ''
  if (typeof v !== 'string') {
    throw Object.assign(new Error('model must be a string or null'), { code: 'INVALID_CONFIG' })
  }
  const t = v.trim()
  if (!t) {
    if (providerId === 'openai-compatible') {
      throw Object.assign(new Error('model is required for openai-compatible'), { code: 'INVALID_CONFIG' })
    }
    throw Object.assign(new Error('model must not be empty'), { code: 'INVALID_CONFIG' })
  }
  return t
}

function coerceBaseUrl(v, providerId) {
  const m = getProviderMetadata(providerId)
  if (v === null) return m.defaultBaseUrl
  const validated = validateBaseUrl(v)
  if (validated === null && providerId === 'openai-compatible') {
    throw Object.assign(new Error('baseUrl is required for openai-compatible'), { code: 'INVALID_CONFIG' })
  }
  return validated
}

function coerceApiKeyEnv(v, providerId) {
  const m = getProviderMetadata(providerId)
  if (v === null) return m.defaultApiKeyEnv
  return validateApiKeyEnv(v)
}

function coerceTimeout(v) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 600) {
    throw Object.assign(new Error('timeoutSec must be between 1 and 600'), { code: 'INVALID_CONFIG' })
  }
  return Math.floor(n)
}

/**
 * Read optional env override: missing → undefined; empty → throw.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 */
function envOverride(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined
  const v = env[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' && v.trim() === '') {
    throw Object.assign(new Error(`${key} is set but empty`), { code: 'INVALID_CONFIG' })
  }
  return typeof v === 'string' ? v.trim() : v
}

/**
 * Full resolve for generate / health / watcher.
 * @param {{ chatAi?: object|null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {ResolvedChatAiConfig}
 */
export function resolveChatAiConfig(opts = {}) {
  const env = opts.env || process.env
  const stored = normalizeStoredChatAi(opts.chatAi ?? defaultStoredChatAi())

  let provider = stored.provider
  const envProvider = envOverride(env, 'CHAT_AI_PROVIDER')
  if (envProvider !== undefined) {
    if (!listProviderIds().includes(envProvider)) {
      throw Object.assign(new Error(`CHAT_AI_PROVIDER unknown: ${envProvider}`), { code: 'INVALID_CONFIG' })
    }
    provider = envProvider
  }

  // If env switches provider, start from that provider's defaults then layer stored+env fields carefully
  const base = provider !== stored.provider
    ? defaultsForProvider(provider)
    : { ...stored, provider }

  const envModel = envOverride(env, 'CHAT_AI_MODEL')
  const envBase = envOverride(env, 'CHAT_AI_BASE_URL')
  const envKey = envOverride(env, 'CHAT_AI_API_KEY_ENV')
  const envTimeout = envOverride(env, 'CHAT_AI_TIMEOUT')

  let model = base.model
  let baseUrl = base.baseUrl
  let apiKeyEnv = base.apiKeyEnv
  let timeoutSec = base.timeoutSec ?? DEFAULT_TIMEOUT_SEC

  if (provider === stored.provider) {
    model = stored.model
    baseUrl = stored.baseUrl
    apiKeyEnv = stored.apiKeyEnv
    timeoutSec = stored.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  }

  if (envModel !== undefined) model = coerceModel(envModel, provider)
  if (envBase !== undefined) baseUrl = validateBaseUrl(envBase)
  if (envKey !== undefined) apiKeyEnv = validateApiKeyEnv(envKey)
  if (envTimeout !== undefined) {
    const n = Number(envTimeout)
    timeoutSec = coerceTimeout(n)
  }

  // openai-compatible requires model + baseUrl
  if (provider === 'openai-compatible') {
    if (!model) {
      throw Object.assign(new Error('model is required for openai-compatible'), { code: 'INVALID_CONFIG' })
    }
    if (!baseUrl) {
      throw Object.assign(new Error('baseUrl is required for openai-compatible'), { code: 'INVALID_CONFIG' })
    }
  }

  // Ensure provider exists
  resolveProvider(provider)

  // Fill nulls from metadata when still null
  const meta = getProviderMetadata(provider)
  if (model == null || model === '') model = meta.defaultModel || ''
  if (baseUrl === undefined) baseUrl = meta.defaultBaseUrl
  if (apiKeyEnv === undefined) apiKeyEnv = meta.defaultApiKeyEnv

  return {
    provider,
    model: String(model),
    baseUrl: baseUrl ?? null,
    apiKeyEnv: apiKeyEnv ?? null,
    timeoutSec,
  }
}

/**
 * Safe public view for GET /settings (never includes key values).
 * @param {ResolvedChatAiConfig} resolved
 * @param {{ env?: NodeJS.ProcessEnv, officeHome?: string, home?: string }} [opts]
 */
export function publicChatAiView(resolved, opts = {}) {
  const meta = getProviderMetadata(resolved.provider)
  const apiKeyConfigured = !!(
    resolved.apiKeyEnv && resolveApiKey(resolved.apiKeyEnv, {
      env: opts.env || process.env,
      officeHome: opts.officeHome,
      home: opts.home,
    })
  )
  return {
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKeyEnv: resolved.apiKeyEnv,
    timeoutSec: resolved.timeoutSec,
    apiKeyConfigured,
    needsApiKey: !!meta.needsApiKey,
    supportsListModels: !!meta.supportsListModels,
    suggestedModels: meta.suggestedModels || [],
  }
}

export { listProviderMeta }
