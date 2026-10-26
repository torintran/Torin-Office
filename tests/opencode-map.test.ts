/**
 * OpenCode → office event mapper (fixtures under tests/fixtures/opencode/).
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  createBridgeState,
  mapBusEvent,
  mapToolBefore,
  mapToolAfter,
  mapPermissionAsk,
  CONNECTION,
} from '../opencode/map-events.js'
import { classifyBash } from '../opencode/classify-bash.js'
import { signRequest } from '../opencode/post-event.js'
import { createHmac } from 'node:crypto'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode')

function load(name: string) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'))
}

describe('mapBusEvent', () => {
  it('A1: parent session.created → session_started with connection=opencode', () => {
    const state = createBridgeState()
    const out = mapBusEvent(state, load('session-created-parent.json'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'ses_parent_001',
      connection: CONNECTION,
      project: 'my-app',
      cwd: '/Users/dev/my-app',
    })
  })

  it('A3: child session.created does not open a pill; links worker', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    mapToolBefore(state, load('tool-before-task.json').input, load('tool-before-task.json').output)
    const out = mapBusEvent(state, load('session-created-child.json'))
    expect(out.every(e => e.type !== 'session_started')).toBe(true)
    expect(out.some(e => e.type === 'agent_started' && e.subagentId === 'ses_child_001')).toBe(true)
    expect(out.some(e => e.type === 'agent_linked')).toBe(true)
  })

  it('A2: parent session.deleted → session_ended', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const out = mapBusEvent(state, load('session-deleted.json'))
    expect(out.some(e => e.type === 'session_ended' && e.sessionId === 'ses_parent_001')).toBe(true)
  })

  it('skips agent-office-bot sessions (chat AI opencode run)', () => {
    const state = createBridgeState()
    const created = mapBusEvent(state, {
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_bot_1',
          title: 'agent-office-bot',
          directory: '/tmp/x',
        },
      },
    })
    expect(created).toEqual([])
    const idle = mapBusEvent(state, {
      type: 'session.idle',
      properties: { sessionID: 'ses_bot_1' },
    })
    expect(idle).toEqual([])
  })

  it('defers untitled session.created; seats on title unless agent-office-bot', () => {
    const state = createBridgeState()
    expect(mapBusEvent(state, {
      type: 'session.created',
      properties: { info: { id: 'ses_u1', directory: '/tmp/app' } },
    })).toEqual([])
    const bot = mapBusEvent(state, {
      type: 'session.updated',
      properties: { info: { id: 'ses_u1', title: 'agent-office-bot', directory: '/tmp/app' } },
    })
    expect(bot.some(e => e.type === 'session_ended')).toBe(true)
    expect(bot.some(e => e.type === 'session_started')).toBe(false)

    expect(mapBusEvent(state, {
      type: 'session.created',
      properties: { info: { id: 'ses_u2', directory: '/tmp/app' } },
    })).toEqual([])
    const real = mapBusEvent(state, {
      type: 'session.updated',
      properties: { info: { id: 'ses_u2', title: 'Fix login', directory: '/tmp/app' } },
    })
    expect(real.some(e => e.type === 'session_started' && e.title === 'Fix login')).toBe(true)
  })

  it('B4: session.idle on parent → session_turn_end with accumulated reply', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    mapBusEvent(state, load('message-updated-user.json'))
    mapBusEvent(state, load('message-updated-assistant.json'))
    mapBusEvent(state, load('message-part-assistant.json'))
    const out = mapBusEvent(state, load('session-idle.json'))
    expect(out).toEqual([expect.objectContaining({
      type: 'session_turn_end',
      sessionId: 'ses_parent_001',
      text: 'Here is the answer about permissions.',
    })])
  })

  it('B5: session.error → session_error', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const out = mapBusEvent(state, load('session-error.json'))
    expect(out[0]).toMatchObject({ type: 'session_error', sessionId: 'ses_parent_001' })
  })

  it('B1: message.updated user → session_prompt', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const out = mapBusEvent(state, load('message-updated-user.json'))
    expect(out[0]).toMatchObject({ type: 'session_prompt', sessionId: 'ses_parent_001', connection: CONNECTION })
  })

  it('E1: todo.updated → task_created / task_completed', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const out = mapBusEvent(state, load('todo-updated.json'))
    expect(out.filter(e => e.type === 'task_created')).toHaveLength(2)
    expect(out.filter(e => e.type === 'task_completed')).toHaveLength(1)
  })
})

describe('mapTool*', () => {
  it('C1: task before → agent_spawned', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const fx = load('tool-before-task.json')
    const out = mapToolBefore(state, fx.input, fx.output)
    expect(out[0]).toMatchObject({
      type: 'agent_spawned',
      agent: expect.objectContaining({ role: 'code-reviewer', name: 'Reviewer' }),
      connection: CONNECTION,
    })
  })

  it('B2: bash before/after on main → agent_working + session_tool_done + signals', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const before = load('tool-before-bash.json')
    const after = load('tool-after-bash.json')
    const b = mapToolBefore(state, before.input, before.output)
    expect(b[0].type).toBe('agent_working')
    expect(b[0].agentId).toBeUndefined()
    expect(b[0].signals?.some((s: { kind: string }) => s.kind === 'test_start')).toBe(true)
    const a = mapToolAfter(state, after.input, after.output)
    expect(a.some(e => e.type === 'session_tool_done')).toBe(true)
    expect(a.find(e => e.type === 'session_tool_done')?.signals?.some((s: { kind: string }) => s.kind === 'test_ok')).toBe(true)
  })

  it('C3: tool on child session tags agentId', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    mapToolBefore(state, load('tool-before-task.json').input, load('tool-before-task.json').output)
    mapBusEvent(state, load('session-created-child.json'))
    const fx = load('tool-child-bash.json')
    const out = mapToolBefore(state, fx.input, fx.output)
    expect(out[0]).toMatchObject({ type: 'agent_working', agentId: 'ses_child_001', sessionId: 'ses_parent_001' })
  })

  it('C4: task after completes child', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    mapToolBefore(state, load('tool-before-task.json').input, load('tool-before-task.json').output)
    mapBusEvent(state, load('session-created-child.json'))
    const fx = load('tool-after-task.json')
    const out = mapToolAfter(state, fx.input, fx.output)
    expect(out.some(e => e.type === 'agent_completed' && e.agentId === 'ses_child_001')).toBe(true)
  })
})

describe('mapPermissionAsk', () => {
  it('D1: permission.ask → session_needs_you answerable', () => {
    const state = createBridgeState()
    mapBusEvent(state, load('session-created-parent.json'))
    const p = load('permission-ask.json').input
    const out = mapPermissionAsk(state, p, { nonce: 'abc', answerable: true })
    expect(out[0]).toMatchObject({
      type: 'session_needs_you',
      kind: 'permission',
      answerable: true,
      nonce: 'abc',
      sessionId: 'ses_parent_001',
      connection: CONNECTION,
    })
  })
})

describe('classifyBash + signRequest', () => {
  it('classifies deploy/test/push', () => {
    expect(classifyBash('npm test', 'start')[0].kind).toBe('test_start')
    expect(classifyBash('git push origin main', 'ok')[0]).toMatchObject({ kind: 'push_done', toDefault: true })
    expect(classifyBash('vercel deploy --prod', 'fail')[0].kind).toBe('deploy_fail')
  })

  it('HMAC matches server scheme', () => {
    const token = 'secret-token'
    const ts = '1700000000000'
    const body = '{"type":"session_started"}'
    const sig = signRequest(token, 'POST', '/event', ts, body)
    const expected = createHmac('sha256', token)
      .update(`POST\n/event\n${ts}\n`)
      .update(body)
      .digest('hex')
    expect(sig).toBe(expected)
  })
})
