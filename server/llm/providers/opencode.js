/**
 * OpenCode CLI adapter for office chat — `opencode run` with --auto.
 * Uses the same models/auth the user already configured in OpenCode.
 */

import { spawn } from 'child_process'
import { flattenMessagesForCli, requireNonEmptyText, validateMessages, unknownHealth } from '../types.js'

export const metadata = {
  id: 'opencode',
  label: 'OpenCode',
  needsApiKey: false,
  defaultApiKeyEnv: null,
  defaultBaseUrl: null,
  chatPath: null,
  // Empty = OpenCode's own default model; or set provider/model e.g. deepseek/...
  defaultModel: '',
  suggestedModels: ['', 'deepseek/deepseek-chat', 'anthropic/claude-sonnet-4'],
  supportsListModels: false,
  /** Cold start of `opencode run` is often >60s */
  defaultTimeoutSec: 180,
}

/**
 * Parse NDJSON from `opencode run --format json` and join text parts.
 * @param {string} stdout
 */
export function parseOpencodeJsonStdout(stdout) {
  const chunks = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    try {
      const ev = JSON.parse(t)
      if (ev?.type === 'text' && typeof ev.part?.text === 'string' && ev.part.text) {
        chunks.push(ev.part.text)
      } else if (ev?.type === 'message' && typeof ev.message?.content === 'string') {
        chunks.push(ev.message.content)
      }
    } catch {
      // skip non-JSON noise
    }
  }
  return chunks.join('').trim()
}

function opencodeSpawn(args, opts = {}) {
  // On Windows the npm shim is opencode.cmd — shell:true finds it on PATH.
  // muteOffice (default true): set AGENT_OFFICE_MUTE so the office plugin does
  // not seat desks / mirror PROMPTs for chat-AI `opencode run` children.
  const { muteOffice = true, env: envOverride, ...rest } = opts
  const env = { ...process.env, ...(envOverride || {}) }
  if (muteOffice) env.AGENT_OFFICE_MUTE = '1'
  return spawn('opencode', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
    ...rest,
  })
}

/**
 * @param {{ messages: import('../types.js').ChatMessage[], model: string, timeoutMs: number, signal?: AbortSignal }} req
 */
export async function generate(req) {
  const messages = validateMessages(req.messages)
  const prompt = flattenMessagesForCli(messages)
  const model = (req.model || '').trim()

  // Lead with the user ask — models otherwise answer the system preamble ("Sounds good…")
  const userLast = [...messages].reverse().find((m) => m.role === 'user')
  const systemBits = messages.filter((m) => m.role === 'system').map((m) => m.content.trim()).filter(Boolean)
  const ask = (userLast?.content || prompt).trim()
  const runPrompt = [
    ask,
    systemBits.length ? `\n\n(Style: ${systemBits.join(' ').slice(0, 240)})` : '',
  ].join('').trim()

  const args = [
    'run',
    '--auto',
    '--format', 'json',
    '--title', 'agent-office-bot',
  ]
  if (model) {
    args.push('--model', model)
  }
  args.push(runPrompt)

  return new Promise((resolve, reject) => {
    const child = opencodeSpawn(args, { muteOffice: true })
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

    // OpenCode cold start can be slow; default chat timeout is often 60s — allow up to req
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      finish(Object.assign(new Error('opencode CLI timed out'), { code: 'TIMEOUT' }))
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
      let text = parseOpencodeJsonStdout(stdout)
      if (!text) {
        // Fallback: last non-JSON line of stdout (default format noise)
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        text = lines.filter((l) => l[0] !== '{').pop() || ''
      }
      if (code !== 0 && !text) {
        finish(Object.assign(new Error(stderr.trim() || `opencode exited ${code}`), { code: 'CLI_ERROR' }))
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
  return new Promise((resolve) => {
    const child = opencodeSpawn(['--version'])
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      resolve(unknownHealth({
        configured: true,
        reachable: false,
        detail: 'opencode CLI did not respond to --version',
      }))
    }, 8000)
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(unknownHealth({
        configured: false,
        reachable: false,
        ready: false,
        detail: "'opencode' CLI not on PATH",
        hint: 'Install OpenCode (npm i -g opencode) and ensure `opencode` is on PATH',
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
          detail: out.trim().split('\n')[0] || 'opencode CLI present',
          mayConsumeTokens: true,
        })
      } else {
        resolve(unknownHealth({
          configured: true,
          reachable: false,
          detail: `opencode --version exited ${code}`,
        }))
      }
    })
  })
}

export default { id: metadata.id, metadata, generate, health }
