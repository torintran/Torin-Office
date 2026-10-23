/**
 * Allowlist registry — only known provider ids; no dynamic import from user input.
 */

import claudeCli from './providers/claude-cli.js'
import deepseek from './providers/deepseek.js'
import ollama from './providers/ollama.js'
import openaiCompatible from './providers/openai-compatible.js'

/** @type {Map<string, object>} */
const PROVIDERS = new Map([
  [claudeCli.id, claudeCli],
  [deepseek.id, deepseek],
  [ollama.id, ollama],
  [openaiCompatible.id, openaiCompatible],
])

export function listProviderIds() {
  return [...PROVIDERS.keys()]
}

/**
 * Public metadata for GET /settings (no secrets).
 */
export function listProviderMeta() {
  return listProviderIds().map((id) => {
    const p = PROVIDERS.get(id)
    const m = p.metadata
    return {
      id: m.id,
      label: m.label,
      needsApiKey: !!m.needsApiKey,
      supportsListModels: !!m.supportsListModels,
      defaultModel: m.defaultModel,
      defaultBaseUrl: m.defaultBaseUrl,
      defaultApiKeyEnv: m.defaultApiKeyEnv,
      suggestedModels: m.suggestedModels || [],
    }
  })
}

/**
 * @param {string} id
 */
export function resolveProvider(id) {
  const p = PROVIDERS.get(id)
  if (!p) {
    throw Object.assign(new Error(`unknown provider: ${id}`), { code: 'INVALID_CONFIG' })
  }
  return p
}

export function getProviderMetadata(id) {
  return resolveProvider(id).metadata
}

export { PROVIDERS }
