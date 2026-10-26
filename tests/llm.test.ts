import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  validateMessages,
  flattenMessagesForCli,
  joinBaseUrl,
  validateBaseUrl,
  validateApiKeyEnv,
  parseEnvFile,
  resolveApiKey,
  chatCompletions,
  resolveChatAiConfig,
  normalizeStoredChatAi,
  defaultsForProvider,
  publicChatAiView,
  listProviderMeta,
  resolveProvider,
} from '../server/llm/index.js'

describe('llm types', () => {
  it('validates messages and flattens with a clear delimiter', () => {
    const msgs = validateMessages([
      { role: 'system', content: 'You are Claude.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(flattenMessagesForCli(msgs)).toContain('---')
    expect(flattenMessagesForCli(msgs)).toMatch(/You are Claude[\s\S]*---[\s\S]*Hello/)
  })

  it('rejects empty messages', () => {
    expect(() => validateMessages([])).toThrow(/non-empty/)
  })
})

describe('llm url', () => {
  it('joins base and path without inventing /v1', () => {
    expect(joinBaseUrl('https://api.deepseek.com', '/chat/completions'))
      .toBe('https://api.deepseek.com/chat/completions')
    expect(joinBaseUrl('http://127.0.0.1:11434/v1/', '/chat/completions'))
      .toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('rejects baseUrl with userinfo, fragment, or query', () => {
    expect(() => validateBaseUrl('https://u:p@host/v1')).toThrow(/username|password/)
    expect(() => validateBaseUrl('https://host/v1#x')).toThrow(/fragment/)
    expect(() => validateBaseUrl('https://host/v1?x=1')).toThrow(/query/)
    expect(validateBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
  })

  it('validates apiKeyEnv names', () => {
    expect(validateApiKeyEnv('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(() => validateApiKeyEnv('bad-name')).toThrow()
    expect(() => validateApiKeyEnv('')).toThrow()
  })
})

describe('llm envKeys', () => {
  it('parses .env and resolves with precedence', () => {
    expect(parseEnvFile('# c\nFOO=bar\nEMPTY=\nQUOTED="hi there"\n')).toEqual({
      FOO: 'bar',
      QUOTED: 'hi there',
    })
    const dir = mkdtempSync(join(tmpdir(), 'llm-env-'))
    try {
      writeFileSync(join(dir, '.env'), 'DEEPSEEK_API_KEY=from-office\n')
      const home = mkdtempSync(join(tmpdir(), 'llm-home-'))
      writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=from-home\n')
      expect(resolveApiKey('DEEPSEEK_API_KEY', {
        env: {},
        home,
        officeHome: dir,
      })).toBe('from-office')
      expect(resolveApiKey('DEEPSEEK_API_KEY', {
        env: { DEEPSEEK_API_KEY: 'from-process' },
        home,
        officeHome: dir,
      })).toBe('from-process')
      rmSync(home, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openaiCompatible', () => {
  it('sends Bearer only when key is non-empty; posts system+user messages', async () => {
    const calls: Array<{ url: string, headers: Record<string, string>, body: any }> = []
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({
        choices: [{ message: { content: '  hi there  ', reasoning_content: 'secret' } }],
      }), { status: 200 })
    }
    const r = await chatCompletions({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      timeoutMs: 5000,
      fetchImpl: fetchImpl as any,
    })
    expect(r.text).toBe('hi there')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    expect(calls[0].body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ])
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')

    calls.length = 0
    await chatCompletions({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: null,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 5000,
      fetchImpl: fetchImpl as any,
    })
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('maps HTTP errors and empty content', async () => {
    const fetch401 = async () => new Response('nope', { status: 401 })
    await expect(chatCompletions({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'x',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 5000,
      fetchImpl: fetch401 as any,
    })).rejects.toMatchObject({ code: 'HTTP_401' })

    const fetchEmpty = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '   ' } }],
    }), { status: 200 })
    await expect(chatCompletions({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'x',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 5000,
      fetchImpl: fetchEmpty as any,
    })).rejects.toMatchObject({ code: 'EMPTY' })
  })
})

describe('config resolver', () => {
  it('defaults claude-cli and deepseek-flash for DeepSeek', () => {
    expect(defaultsForProvider('claude-cli').model).toBe('claude-haiku-5-5')
    expect(defaultsForProvider('deepseek').model).toBe('deepseek-flash')
    expect(defaultsForProvider('deepseek').baseUrl).toBe('https://api.deepseek.com')
    expect(defaultsForProvider('opencode').provider).toBe('opencode')
    expect(defaultsForProvider('opencode').timeoutSec).toBe(180)
  })

  it('parses OpenCode run --format json text parts', async () => {
    const { parseOpencodeJsonStdout } = await import('../server/llm/providers/opencode.js')
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"Hello "}}',
      '{"type":"text","part":{"type":"text","text":"office"}}',
    ].join('\n')
    expect(parseOpencodeJsonStdout(stdout)).toBe('Hello office')
  })

  it('switches provider without keeping old model/url', () => {
    const next = normalizeStoredChatAi(
      { provider: 'ollama' },
      { previous: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', timeoutSec: 60 } },
    )
    expect(next.provider).toBe('ollama')
    expect(next.model).toBe('llama3.2')
    expect(next.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(next.apiKeyEnv).toBeNull()
  })

  it('rejects empty env overrides', () => {
    expect(() => resolveChatAiConfig({
      chatAi: defaultsForProvider('claude-cli'),
      env: { CHAT_AI_BASE_URL: '' } as any,
    })).toThrow(/empty/)
  })

  it('public view never includes secret values', () => {
    const resolved = resolveChatAiConfig({
      chatAi: defaultsForProvider('deepseek'),
      env: { DEEPSEEK_API_KEY: 'sk-secret-value' } as any,
    })
    const pub = publicChatAiView(resolved, { env: { DEEPSEEK_API_KEY: 'sk-secret-value' } as any })
    expect(JSON.stringify(pub)).not.toContain('sk-secret-value')
    expect(pub.apiKeyConfigured).toBe(true)
    expect(pub.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  })
})

describe('registry', () => {
  it('allowlists known providers only', () => {
    expect(listProviderMeta().map((p: any) => p.id)).toEqual([
      'claude-cli', 'opencode', 'deepseek', 'ollama', 'openai-compatible',
    ])
    expect(() => resolveProvider('evil')).toThrow(/unknown/)
  })
})
