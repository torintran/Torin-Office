/**
 * Settings chatAi + /llm/health + /llm/models — server is source of truth.
 */
import { createServer } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOffice, postAuthed, removeOffice, type Office } from './helpers'

describe('chatAi settings and LLM routes', () => {
  let office: Office
  afterEach(() => removeOffice(office))

  it('GET /settings exposes public chatAi without secrets; provider switch resets model/url', async () => {
    office = await loadOffice()
    process.env.DEEPSEEK_API_KEY = 'sk-should-never-appear-in-response'
    try {
      const get = await request(office.server.app).get('/settings')
      expect(get.status).toBe(200)
      expect(get.body.chatAi).toMatchObject({ provider: 'claude-cli', model: 'claude-haiku-5-5' })
      expect(JSON.stringify(get.body)).not.toContain('sk-should-never-appear')
      expect(get.body.chatAiProviders.map((p: { id: string }) => p.id)).toContain('deepseek')

      const set = await postAuthed(office.server, '/settings', { chatAi: { provider: 'deepseek' } })
      expect(set.status).toBe(200)
      expect(set.body.chatAi).toMatchObject({
        provider: 'deepseek',
        model: 'deepseek-flash',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKeyConfigured: true,
      })
      expect(JSON.stringify(set.body)).not.toContain('sk-should-never-appear')

      const saved = JSON.parse(readFileSync(join(office.dir, 'settings.json'), 'utf8'))
      expect(saved.chatAi.provider).toBe('deepseek')
      expect(saved.chatAi.model).toBe('deepseek-flash')
      expect(JSON.stringify(saved)).not.toContain('sk-should-never-appear')

      const ollama = await postAuthed(office.server, '/settings', { chatAi: { provider: 'ollama' } })
      expect(ollama.body.chatAi.provider).toBe('ollama')
      expect(ollama.body.chatAi.model).toBe('llama3.2')
      expect(ollama.body.chatAi.baseUrl).toBe('http://127.0.0.1:11434/v1')
      expect(ollama.body.chatAi.apiKeyEnv).toBeNull()
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  it('rejects empty CHAT_AI_BASE_URL via invalid stored baseUrl and bad apiKeyEnv', async () => {
    office = await loadOffice()
    const badKey = await postAuthed(office.server, '/settings', {
      chatAi: { provider: 'deepseek', apiKeyEnv: 'bad-name' },
    })
    expect(badKey.status).toBe(400)

    const badUrl = await postAuthed(office.server, '/settings', {
      chatAi: { provider: 'openai-compatible', model: 'x', baseUrl: 'https://user:pass@host/v1' },
    })
    expect(badUrl.status).toBe(400)
  })

  it('POST /llm/health light check reports missing key; generate probe hits mock', async () => {
    office = await loadOffice()
    await postAuthed(office.server, '/settings', {
      chatAi: { provider: 'deepseek', apiKeyEnv: 'TORIN_LLM_TEST_NO_KEY' },
    })
    const missing = await postAuthed(office.server, '/llm/health', { probe: 'light' })
    expect(missing.status).toBe(200)
    expect(missing.body.configured).toBe(false)
    expect(missing.body.hint).toMatch(/TORIN_LLM_TEST_NO_KEY/)
    expect(JSON.stringify(missing.body)).not.toMatch(/sk-/)

    const server = createServer((req, res) => {
      if (req.url === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    try {
      process.env.TORIN_LLM_TEST_KEY = 'sk-test'
      await postAuthed(office.server, '/settings', {
        chatAi: {
          provider: 'openai-compatible',
          model: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKeyEnv: 'TORIN_LLM_TEST_KEY',
        },
      })
      const gen = await postAuthed(office.server, '/llm/health', { probe: 'generate' })
      expect(gen.status).toBe(200)
      expect(gen.body.ready).toBe(true)
      expect(gen.body.mayConsumeTokens).toBe(true)
    } finally {
      delete process.env.TORIN_LLM_TEST_KEY
      server.close()
    }
  })

  it('preserves user model across restart; does not reset when metadata defaults differ', async () => {
    office = await loadOffice()
    await postAuthed(office.server, '/settings', {
      chatAi: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    const dir = office.dir
    removeOffice(office)
    office = await loadOffice({ dir })
    expect(office.server.settings.chatAi.model).toBe('deepseek-v4-pro')
    const get = await request(office.server.app).get('/settings')
    expect(get.body.chatAi.model).toBe('deepseek-v4-pro')
  })

  it('reads api key from AGENT_OFFICE_HOME/.env when process env is unset (Electron-like)', async () => {
    office = await loadOffice()
    writeFileSync(join(office.dir, '.env'), 'DEEPSEEK_API_KEY=from-dotenv-file\n', { mode: 0o600 })
    delete process.env.DEEPSEEK_API_KEY
    await postAuthed(office.server, '/settings', { chatAi: { provider: 'deepseek' } })
    const get = await request(office.server.app).get('/settings')
    expect(get.body.chatAi.apiKeyConfigured).toBe(true)
    expect(JSON.stringify(get.body)).not.toContain('from-dotenv-file')
  })
})
