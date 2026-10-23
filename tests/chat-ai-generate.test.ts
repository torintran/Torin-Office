import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { createServer } from 'http'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GEN = join(ROOT, 'scripts', 'chat-ai-generate.mjs')

function runGenerate(input: object, env: Record<string, string> = {}, timeoutMs = 15000) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [GEN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ code: -1, stdout, stderr: stderr + '\ntimeout' })
    }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

describe('chat-ai-generate.mjs', () => {
  it('returns JSON ok with text from a mock OpenAI-compatible server', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/chat/completions') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          const parsed = JSON.parse(body)
          expect(parsed.messages[0].role).toBe('system')
          expect(req.headers.authorization).toBeUndefined()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'short reply here' } }] }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    try {
      const { code, stdout } = await runGenerate({
        provider: 'openai-compatible',
        model: 'test-model',
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 5000,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
        ],
      })
      expect(code).toBe(0)
      const line = JSON.parse(stdout.trim())
      expect(line).toEqual({ ok: true, text: 'short reply here' })
    } finally {
      server.close()
    }
  })

  it('exits non-zero on HTTP 401 without leaking secrets', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401)
      res.end('no')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    try {
      const { code, stdout } = await runGenerate({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        timeoutMs: 5000,
        messages: [{ role: 'user', content: 'hi' }],
      }, { DEEPSEEK_API_KEY: 'sk-super-secret-should-not-leak' })
      expect(code).not.toBe(0)
      expect(stdout).not.toContain('sk-super-secret')
      const line = JSON.parse(stdout.trim())
      expect(line.ok).toBe(false)
      expect(line.error.code).toBe('HTTP_401')
    } finally {
      server.close()
    }
  })

  it('fails clearly when DeepSeek key is missing', async () => {
    const { code, stdout } = await runGenerate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      timeoutMs: 3000,
      messages: [{ role: 'user', content: 'hi' }],
    }, { DEEPSEEK_API_KEY: '' })
    // empty env var may still fall through to .env; force unset by using a unique env name
    const r2 = await runGenerate({
      provider: 'deepseek',
      model: 'deepseek-flash',
      apiKeyEnv: 'TORIN_TEST_MISSING_KEY_XYZ',
      timeoutMs: 3000,
      messages: [{ role: 'user', content: 'hi' }],
    }, {})
    expect(r2.code).not.toBe(0)
    const line = JSON.parse(r2.stdout.trim())
    expect(line.ok).toBe(false)
    expect(line.error.code).toBe('MISSING_KEY')
    expect(line.error.message).toContain('TORIN_TEST_MISSING_KEY_XYZ')
    void code
    void stdout
  })

  it('times out and exits non-zero when the API hangs', async () => {
    const server = createServer((_req, _res) => {
      // never respond
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    try {
      const { code, stdout } = await runGenerate({
        provider: 'openai-compatible',
        model: 'slow',
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 400,
        messages: [{ role: 'user', content: 'hi' }],
      }, {}, 10000)
      expect(code).not.toBe(0)
      const line = JSON.parse(stdout.trim())
      expect(line.ok).toBe(false)
      expect(line.error.code).toBe('TIMEOUT')
    } finally {
      server.close()
    }
  })
})
