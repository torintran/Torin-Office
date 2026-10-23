/**
 * Shared LLM types and validation for multi-provider Chat AI.
 * No secrets; no provider-specific HTTP here.
 */

/** @typedef {'system'|'user'|'assistant'} ChatRole */
/** @typedef {{ role: ChatRole, content: string }} ChatMessage */
/** @typedef {{ messages: ChatMessage[], model: string, timeoutMs: number, signal?: AbortSignal }} GenerateRequest */
/** @typedef {{ text: string, usage?: object }} GenerateResult */
/** @typedef {true|false|'unknown'} HealthFlag */
/**
 * @typedef {{
 *   configured: HealthFlag,
 *   reachable: HealthFlag,
 *   authenticated: HealthFlag,
 *   modelAvailable: HealthFlag,
 *   ready: HealthFlag,
 *   detail?: string,
 *   hint?: string,
 *   mayConsumeTokens?: boolean,
 *   mayConsumeLocalResources?: boolean,
 * }} HealthResult
 */

export const CHAT_ROLES = new Set(['system', 'user', 'assistant'])

/**
 * @param {unknown} messages
 * @returns {ChatMessage[]}
 */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('messages must be a non-empty array'), { code: 'INVALID_INPUT' })
  }
  const out = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      throw Object.assign(new Error('each message must be an object'), { code: 'INVALID_INPUT' })
    }
    const role = m.role
    const content = m.content
    if (!CHAT_ROLES.has(role)) {
      throw Object.assign(new Error(`invalid message role: ${String(role)}`), { code: 'INVALID_INPUT' })
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw Object.assign(new Error('message content must be a non-empty string'), { code: 'INVALID_INPUT' })
    }
    out.push({ role, content })
  }
  return out
}

/**
 * Flatten system + user messages for Claude CLI free-form prompt.
 * Clear delimiter so persona is not confused with user context.
 * @param {ChatMessage[]} messages
 */
export function flattenMessagesForCli(messages) {
  const systemParts = []
  const restParts = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content.trim())
    else restParts.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content.trim()}`)
  }
  const system = systemParts.join('\n\n')
  const rest = restParts.join('\n\n')
  if (system && rest) return `${system}\n\n---\n\n${rest}`
  return system || rest
}

/**
 * @param {string} text
 * @returns {string}
 */
export function requireNonEmptyText(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) {
    throw Object.assign(new Error('empty model response'), { code: 'EMPTY' })
  }
  return t
}

/**
 * @returns {HealthResult}
 */
export function unknownHealth(partial = {}) {
  return {
    configured: 'unknown',
    reachable: 'unknown',
    authenticated: 'unknown',
    modelAvailable: 'unknown',
    ready: 'unknown',
    ...partial,
  }
}
