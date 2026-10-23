#!/usr/bin/env node
/**
 * chat-ai-generate.mjs — one-shot LLM generate for the office chat watcher.
 *
 * Contract (only supported I/O):
 *   stdin  JSON: { messages, provider?, model?, baseUrl?, apiKeyEnv?, timeoutMs? }
 *   stdout one JSON line: { ok: true, text } | { ok: false, error: { code, message } }
 *   exit   0 on success with non-empty text; non-zero on failure
 *
 * Never put prompts or secrets on argv. API keys resolved inside this process.
 */

import { resolveChatAiConfig, resolveProvider, validateMessages } from '../server/llm/index.js'

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(chunks.join('')))
    process.stdin.on('error', reject)
  })
}

function fail(code, message, exitCode = 1) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n')
  process.exit(exitCode)
}

function ok(text) {
  process.stdout.write(JSON.stringify({ ok: true, text }) + '\n')
  process.exit(0)
}

async function main() {
  let raw
  try {
    raw = await readStdin()
  } catch (err) {
    fail('INVALID_INPUT', err instanceof Error ? err.message : String(err))
    return
  }

  let input
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    fail('INVALID_INPUT', 'stdin must be JSON')
    return
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_INPUT', 'stdin JSON must be an object')
    return
  }

  let messages
  try {
    messages = validateMessages(input.messages)
  } catch (err) {
    fail(err.code || 'INVALID_INPUT', err.message)
    return
  }

  let resolved
  try {
    const chatAi = {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
      timeoutSec: input.timeoutMs != null ? Math.ceil(Number(input.timeoutMs) / 1000) : undefined,
    }
    // Drop undefined so normalize uses defaults / settings merge path via resolve
    const cleaned = Object.fromEntries(
      Object.entries(chatAi).filter(([, v]) => v !== undefined),
    )
    resolved = resolveChatAiConfig({
      chatAi: Object.keys(cleaned).length ? cleaned : undefined,
      env: process.env,
    })
  } catch (err) {
    fail(err.code || 'INVALID_CONFIG', err.message)
    return
  }

  // Explicit stdin fields win over resolved for this one call (watcher passes full config)
  const providerId = input.provider || resolved.provider
  const model = input.model || resolved.model
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl : resolved.baseUrl
  const apiKeyEnv = input.apiKeyEnv !== undefined ? input.apiKeyEnv : resolved.apiKeyEnv
  const timeoutMs = Number.isFinite(Number(input.timeoutMs))
    ? Math.max(1, Number(input.timeoutMs))
    : resolved.timeoutSec * 1000

  let provider
  try {
    provider = resolveProvider(providerId)
  } catch (err) {
    fail(err.code || 'INVALID_CONFIG', err.message)
    return
  }

  try {
    const result = await provider.generate({
      messages,
      model,
      baseUrl,
      apiKeyEnv,
      timeoutMs,
      officeHome: process.env.AGENT_OFFICE_HOME,
    })
    const text = typeof result?.text === 'string' ? result.text.trim() : ''
    if (!text) fail('EMPTY', 'empty model response')
    else ok(text)
  } catch (err) {
    const code = err?.code || 'GENERATE_ERROR'
    const message = err instanceof Error ? err.message : String(err)
    // Never echo secrets
    fail(code, message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'))
  }
}

main().catch((err) => {
  fail('GENERATE_ERROR', err instanceof Error ? err.message : String(err))
})
