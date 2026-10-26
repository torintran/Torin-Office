#!/usr/bin/env node
/**
 * chat-ai-watcher.mjs — cross-platform chat reply loop (Windows + macOS + Linux).
 * Same job as chat-ai-watcher.sh: poll GET /chat, generate via chat-ai-generate.mjs,
 * POST /chat/reply. Only answers role=default human messages (not PROMPT tags from
 * OpenCode session_prompt / agent clock-in lines).
 *
 *   node scripts/chat-ai-watcher.mjs
 *   npm run chat-ai
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.AGENT_OFFICE_PORT || '3334'
const SERVER = `http://127.0.0.1:${PORT}`
const POLL_MS = Math.max(2, Number(process.env.CHAT_AI_POLL_INTERVAL) || 8) * 1000
const MAX_REPLIES_PER_MIN = Math.max(1, Number(process.env.CHAT_AI_MAX_REPLIES_PER_MIN) || 5)
const STATE_DIR = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
const PID_FILE = join(STATE_DIR, 'chat-watcher.pid')
const LAST_TS_FILE = join(STATE_DIR, 'chat-ai-last-ts')
const LOCK_FILE = join(STATE_DIR, 'chat-ai.lock')
const GEN_SCRIPT = join(__dirname, 'chat-ai-generate.mjs')

const ROUTES = [
  [['bug', 'error', 'crash', 'fix', 'broken', 'debug'], 'debugger', 'Debugger'],
  [['review', 'pr ', 'merge', 'lgtm'], 'code-reviewer', 'Reviewer'],
  [['css', 'ui', 'frontend', 'design', 'layout'], 'frontend-developer', 'Frontend'],
  [['test', 'coverage', 'jest', 'pytest', 'e2e'], 'test-engineer', 'Tester'],
  [['security', 'auth', 'vuln', 'xss', 'jwt'], 'security-auditor', 'Security'],
  [['deploy', 'docker', 'ci', 'devops', 'k8s'], 'devops-engineer', 'DevOps'],
  [['perf', 'slow', 'latency', 'optimize'], 'performance-engineer', 'PerfEng'],
  [['db', 'sql', 'schema', 'postgres', 'mongo'], 'database-architect', 'DBA'],
  [['typescript', 'type', 'interface', 'zod'], 'typescript-pro', 'TS Pro'],
  // No bare "ai" — matches Vietnamese "là ai" (who) and many Latin substrings
  [['ai eng', 'ai engineer', 'llm', 'openai', 'chatgpt', 'embedding', 'rag'], 'ai-engineer', 'AI Eng'],
  [['api', 'endpoint', 'rest', 'graphql', 'webhook'], 'fullstack-developer', 'Fullstack'],
  [['architecture', 'refactor', 'pattern'], 'architect-reviewer', 'Architect'],
]

/** Escape a string for use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Keyword hit with unicode letter boundaries for short/ambiguous tokens
 * (ui, ci, db, …) so "said"/"mail"/"là ai" do not false-trigger.
 */
function keywordHit(text, word) {
  const w = String(word || '').trim().toLowerCase()
  if (!w) return false
  if (w.includes(' ')) return text.includes(w)
  if (w.length <= 3) {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
  }
  return text.includes(w)
}

let lastTs = 0
let callTimes = []
let busy = false

function log(...args) {
  console.log('[chat-ai]', ...args)
}

function readLastTs() {
  try {
    const t = readFileSync(LAST_TS_FILE, 'utf8').trim()
    if (/^\d+$/.test(t) && Number(t) <= Date.now() + 60_000) return Number(t)
  } catch {}
  const now = Date.now()
  writeFileSync(LAST_TS_FILE, String(now), 'utf8')
  return now
}

function saveLastTs(ts) {
  writeFileSync(LAST_TS_FILE, String(ts), 'utf8')
}

async function getJson(path) {
  const res = await fetch(`${SERVER}${path}`)
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json()
}

function readToken() {
  try {
    return readFileSync(join(STATE_DIR, 'auth-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function routeMessage(msg, provider) {
  const low = msg.toLowerCase()
  for (const [words, role, name] of ROUTES) {
    if (words.some((w) => keywordHit(low, w))) return { role, name }
  }
  return {
    role: 'assistant',
    name: provider === 'opencode' ? 'OpenCode' : 'Claude',
  }
}

function rateCapHit() {
  const now = Math.floor(Date.now() / 1000)
  callTimes = callTimes.filter((t) => now - t < 60)
  return callTimes.length >= MAX_REPLIES_PER_MIN
}

function typedByPerson(m) {
  const text = m?.text
  return m?.role === 'default'
    && !m?.is_system
    && !m?.recipient
    && typeof text === 'string'
    && text.trim() !== ''
    && !text.trimStart().startsWith('/')
}

function generate(payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GEN_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      resolve({ ok: false, error: { code: 'TIMEOUT', message: 'generate timed out' } })
    }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: { code: 'CLI_ERROR', message: err.message } })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: { code: 'CLI_ERROR', message: stderr.trim() || 'bad generate output' } })
      }
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

async function replyTo(text) {
  busy = true
  writeFileSync(LOCK_FILE, String(process.pid), 'utf8')
  try {
    let settings = {}
    try { settings = await getJson('/settings') } catch {}
    const chatAi = settings.chatAi || {}
    const provider = process.env.CHAT_AI_PROVIDER || chatAi.provider || 'claude-cli'
    const model = process.env.CHAT_AI_MODEL || chatAi.model || ''
    const timeoutSec = Number(process.env.CHAT_AI_TIMEOUT || chatAi.timeoutSec || 60)
    const { role, name } = routeMessage(text, provider)
    log(`Routed to: ${name} (${role}) · ${provider}`)

    let recent = []
    try {
      const chat = await getJson('/chat')
      recent = (chat.messages || []).slice(-10)
    } catch {}
    const context = recent.map((m) => `${m.sender || '?'}: ${m.text || ''}`).join('\n')

    const system = `Reply as ${name}. Answer the user's latest message in 1–3 short sentences. If they asked a question, answer it — do not only greet.`
    const user = context
      ? `Recent chat:\n${context}\n\nAnswer this message:\n${text}`
      : text

    callTimes.push(Math.floor(Date.now() / 1000))
    log(`Generating reply (${provider} · ${model || 'default'})...`)
    const result = await generate({
      provider,
      model: model || undefined,
      baseUrl: chatAi.baseUrl,
      apiKeyEnv: chatAi.apiKeyEnv,
      timeoutMs: Math.max(5, timeoutSec) * 1000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, Math.max(5, timeoutSec) * 1000 + 5000)

    if (!result?.ok || !result.text?.trim()) {
      log(`Generate failed — ${result?.error?.code || 'UNKNOWN'}: ${result?.error?.message || ''}`)
      return
    }
    // Cap length for Slack panel readability (chars, not a hard 15-word gag)
    const reply = result.text.trim().replace(/\s+/g, ' ').slice(0, 500)
    log(`Replying as ${name}: ${reply.slice(0, 120)}`)

    const token = readToken()
    const res = await fetch(`${SERVER}/chat/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ sender: name, role, text: reply }),
    })
    if (!res.ok) {
      log(`Failed to post reply — HTTP ${res.status}`)
      return
    }
    log('Done')
  } finally {
    busy = false
    try { unlinkSync(LOCK_FILE) } catch {}
  }
}

async function tick() {
  try {
    await getJson('/health')
  } catch {
    return
  }

  try {
    const cron = await getJson('/chat/cron-state')
    if (cron.paused) return
  } catch {
    return
  }

  let data
  try {
    data = await getJson(`/chat?since=${lastTs}`)
  } catch {
    return
  }

  const msgs = data.messages || []
  const newest = msgs.reduce((m, x) => Math.max(m, Number(x.timestamp) || 0), 0)
  if (newest > lastTs) {
    lastTs = newest
    saveLastTs(lastTs)
  }

  const human = msgs.filter(typedByPerson)
  if (!human.length) return
  const text = String(human[human.length - 1].text).replace(/[\r\n]+/g, ' ').trim()
  if (!text) return

  if (busy || existsSync(LOCK_FILE)) {
    log('Skipping — already generating a reply')
    return
  }
  if (rateCapHit()) {
    log(`Reply cap reached (${MAX_REPLIES_PER_MIN}/min) — not answering: ${text}`)
    return
  }

  log(`New message: ${text}`)
  await replyTo(text)
}

function cleanup() {
  try { unlinkSync(PID_FILE) } catch {}
  try { unlinkSync(LOCK_FILE) } catch {}
  log('Stopped')
  process.exit(0)
}

const isMain = process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])

if (isMain) {
  mkdirSync(STATE_DIR, { recursive: true })
  try { unlinkSync(LOCK_FILE) } catch {}
  writeFileSync(PID_FILE, String(process.pid), 'utf8')
  lastTs = readLastTs()

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  log(`Started (pid ${process.pid}), polling ${SERVER} every ${POLL_MS / 1000}s`)
  setInterval(() => { void tick() }, POLL_MS)
  void tick()
}
