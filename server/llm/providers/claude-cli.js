/**
 * Claude Code CLI adapter — keeps existing safe flags; free-form prompt via -p.
 * Does not use Anthropic SDK.
 */

import { spawn, spawnSync } from 'child_process'
import { flattenMessagesForCli, requireNonEmptyText, validateMessages, unknownHealth } from '../types.js'

/**
 * Resolve `claude` on PATH. On Windows, Node cannot execute a shebang bash
 * script via spawn('claude'), so we run it through bash when needed.
 * @returns {{ cmd: string, prefixArgs: string[] }}
 */
function claudeSpawnSpec(bin = 'claude') {
  if (process.platform !== 'win32') return { cmd: bin, prefixArgs: [] }
  // Prefer Git Bash / WSL-less bash on PATH
  const which = spawnSync('bash', ['-c', `command -v ${bin === 'claude' ? 'claude' : bin}`], {
    encoding: 'utf8',
    env: process.env,
  })
  const resolved = (which.stdout || '').trim().split(/\r?\n/)[0]
  if (resolved) return { cmd: 'bash', prefixArgs: [resolved] }
  return { cmd: 'bash', prefixArgs: [bin] }
}

export const metadata = {
  id: 'claude-cli',
  label: 'Claude CLI',
  needsApiKey: false,
  defaultApiKeyEnv: null,
  defaultBaseUrl: null,
  chatPath: null,
  defaultModel: 'claude-haiku-5-5',
  suggestedModels: ['claude-haiku-5-5', 'claude-sonnet-4-5'],
  supportsListModels: false,
}

/**
 * @param {{ messages: import('../types.js').ChatMessage[], model: string, timeoutMs: number, signal?: AbortSignal, claudeBin?: string }} req
 */
export async function generate(req) {
  const messages = validateMessages(req.messages)
  const model = (req.model || metadata.defaultModel).trim()
  const prompt = flattenMessagesForCli(messages)
  const bin = req.claudeBin || 'claude'
  const spec = claudeSpawnSpec(bin)

  const args = [
    ...spec.prefixArgs,
    '-p', prompt,
    '--max-turns', '1',
    '--model', model,
    '--safe-mode',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
    '--name', 'agent-office-bot',
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (err, result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) reject(err)
      else resolve(result)
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      finish(Object.assign(new Error('claude CLI timed out'), { code: 'TIMEOUT' }))
    }, Math.max(1, req.timeoutMs))

    if (req.signal) {
      if (req.signal.aborted) {
        try { child.kill('SIGTERM') } catch {}
        finish(Object.assign(new Error('aborted'), { code: 'TIMEOUT' }))
        return
      }
      req.signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM') } catch {}
        finish(Object.assign(new Error('aborted'), { code: 'TIMEOUT' }))
      }, { once: true })
    }

    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      const code = err.code === 'ENOENT' ? 'CLI_MISSING' : 'CLI_ERROR'
      finish(Object.assign(new Error(err.message), { code }))
    })
    child.on('close', (code) => {
      if (settled) return
      const text = stdout.replace(/\n/g, ' ').trim()
      if (code !== 0 && !text) {
        finish(Object.assign(new Error(stderr.trim() || `claude exited ${code}`), { code: 'CLI_ERROR' }))
        return
      }
      try {
        finish(null, { text: requireNonEmptyText(text) })
      } catch (e) {
        finish(e)
      }
    })
  })
}

export async function health() {
  // Light check: is `claude` on PATH?
  return new Promise((resolve) => {
    const spec = claudeSpawnSpec('claude')
    const child = spawn(spec.cmd, [...spec.prefixArgs, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      resolve(unknownHealth({
        configured: true,
        reachable: false,
        detail: 'claude CLI did not respond to --version',
      }))
    }, 5000)
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(unknownHealth({
        configured: false,
        reachable: false,
        ready: false,
        detail: "'claude' CLI not on PATH",
        hint: 'Install Claude Code and ensure `claude` is on PATH',
      }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) {
        resolve({
          configured: true,
          reachable: true,
          authenticated: 'unknown',
          modelAvailable: 'unknown',
          ready: 'unknown',
          detail: out.trim().split('\n')[0] || 'claude CLI present',
          mayConsumeTokens: false,
        })
      } else {
        resolve(unknownHealth({
          configured: true,
          reachable: false,
          detail: `claude --version exited ${code}`,
        }))
      }
    })
  })
}

export default { id: metadata.id, metadata, generate, health }
