/**
 * Agent Office ↔ OpenCode plugin (OpenCode 2.x).
 *
 * Default export: `{ id, setup(ctx), server?(ctx) }`.
 * Forwards session / tool / task / permission / todo activity to
 * POST http://127.0.0.1:3334/event with connection: "opencode".
 *
 * This is NOT an LLM provider. Use OpenCode with any model (DeepSeek, …);
 * the office only visualizes what OpenCode is doing.
 */

import {
  createBridgeState,
  mapBusEvent,
  mapToolBefore,
  mapToolAfter,
  mapPermissionAsk,
} from './map-events.js'
import {
  postEvent,
  pollPermissionDecision,
  answerPermissionsEnabled,
  newNonce,
  readToken,
} from './post-event.js'

async function emitAll(events) {
  for (const event of events) {
    if (!event) continue
    await postEvent(event)
  }
}

function directoryOf(ctx) {
  return ctx?.location?.directory || ctx?.directory || undefined
}

function projectName(dir) {
  if (!dir) return undefined
  return String(dir).split(/[\\/]/).filter(Boolean).pop()
}

function toolBeforeParts(event) {
  const tool = event?.tool || event?.toolName || event?.name
  const sessionID = event?.sessionID || event?.sessionId || event?.session?.id
  const callID = event?.callID || event?.callId || event?.id
  const args = event?.input ?? event?.args ?? {}
  return {
    input: { tool, sessionID, callID },
    output: { args },
  }
}

function toolAfterParts(event) {
  const tool = event?.tool || event?.toolName || event?.name
  const sessionID = event?.sessionID || event?.sessionId || event?.session?.id
  const callID = event?.callID || event?.callId || event?.id
  const args = event?.input ?? event?.args ?? {}
  return {
    input: { tool, sessionID, callID, args },
    output: {
      title: event?.title || event?.output?.title || tool,
      output: typeof event?.output === 'string'
        ? event.output
        : (event?.output?.output ?? event?.result ?? ''),
      metadata: event?.metadata || event?.output?.metadata || {},
      error: event?.error,
    },
  }
}

function permissionFromEvent(event) {
  const meta = event?.metadata || event?.input || {}
  const tool =
    event?.tool ||
    event?.permission ||
    meta?.tool ||
    meta?.name ||
    (event?.type && event.type !== 'permission' ? event.type : null) ||
    'tool'
  return {
    id: event?.id || event?.permissionID || event?.permissionId,
    type: String(tool),
    sessionID: event?.sessionID || event?.sessionId,
    messageID: event?.messageID || event?.messageId,
    callID: event?.callID || event?.callId,
    title: event?.title || event?.message || meta?.command || String(tool),
    metadata: meta,
  }
}

function officeMuted() {
  const v = String(process.env.AGENT_OFFICE_MUTE || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function createHooks(ctx) {
  const state = createBridgeState()
  const dir = directoryOf(ctx)
  if (dir) state.cwdBySession.set('__plugin_cwd__', dir)

  return {
    async onBusEvent(event) {
      if (officeMuted()) return
      try {
        let ev = event
        if (ev?.type === 'session.created' && ev.properties?.info && !ev.properties.info.parentID) {
          if (!ev.properties.info.directory && dir) {
            ev = {
              ...ev,
              properties: {
                ...ev.properties,
                info: { ...ev.properties.info, directory: dir },
              },
            }
          }
        }
        await emitAll(mapBusEvent(state, ev))
      } catch {}
    },

    async onPrompt(event) {
      if (officeMuted()) return
      try {
        const sid = event?.sessionID || event?.sessionId || event?.session?.id
        if (!sid) return
        if (state.ignoredSessions.has(sid)) return
        const text = String(event?.prompt?.text || event?.text || '').slice(0, 2000)
        // Chat-AI bot prompts look like office system text — never mirror as Boss PROMPT
        if (/agent-office-bot/i.test(text) || /^You are responding as /i.test(text) || /^Reply as /i.test(text)) {
          state.ignoredSessions.add(sid)
          return
        }
        await emitAll([{
          type: 'session_prompt',
          text,
          promptId: event?.messageID || event?.messageId,
          sessionId: sid,
          connection: 'opencode',
          ...(dir ? { cwd: dir, project: projectName(dir) } : {}),
        }])
      } catch {}
    },

    async onToolBefore(event) {
      if (officeMuted()) return
      try {
        const { input, output } = toolBeforeParts(event)
        await emitAll(mapToolBefore(state, input, output))
      } catch {}
    },

    async onToolAfter(event) {
      if (officeMuted()) return
      try {
        const { input, output } = toolAfterParts(event)
        await emitAll(mapToolAfter(state, input, output))
      } catch {}
    },

    async onPermission(event) {
      if (officeMuted()) return
      try {
        const permission = permissionFromEvent(event)
        if (!permission.sessionID) return

        if (!answerPermissionsEnabled() || !readToken()) {
          await emitAll(mapPermissionAsk(state, permission, { answerable: false }))
          return
        }

        const nonce = newNonce()
        const events = mapPermissionAsk(state, permission, { nonce, answerable: true })
        const first = events[0]
        if (!first) return
        const res = await postEvent(first)
        const permissionId = res?.body?.permissionId
        if (!res.ok || !permissionId) return

        const decision = await pollPermissionDecision(permissionId)
        if (decision === 'allow' && event && typeof event === 'object') event.status = 'allow'
        else if (decision === 'deny' && event && typeof event === 'object') event.status = 'deny'
      } catch {}
    },
  }
}

function v1HookObject(hooks) {
  return {
    event: async ({ event }) => hooks.onBusEvent(event),
    'chat.message': async (input, output) => {
      const parts = output?.parts || []
      const text = parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
      await hooks.onPrompt({
        sessionID: input?.sessionID,
        messageID: input?.messageID || output?.message?.id,
        prompt: { text },
      })
    },
    'tool.execute.before': async (input, output) => {
      await hooks.onToolBefore({ ...input, input: output?.args, args: output?.args })
    },
    'tool.execute.after': async (input, output) => {
      await hooks.onToolAfter({
        ...input,
        args: input?.args,
        title: output?.title,
        output: output?.output,
        metadata: output?.metadata,
      })
    },
    'permission.ask': async (permission, output) => {
      const ev = { ...permission }
      await hooks.onPermission(ev)
      if (ev.status) output.status = ev.status
    },
  }
}

export default {
  id: 'agent-office',

  async setup(ctx) {
    const hooks = createHooks(ctx)
    const controller = new AbortController()

    void (async () => {
      try {
        if (!ctx?.event?.subscribe) return
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await hooks.onBusEvent(event)
        }
      } catch {}
    })()

    try {
      if (ctx?.session?.hook) {
        await ctx.session.hook('prompt', (event) => { void hooks.onPrompt(event) })
      }
    } catch {}

    try {
      if (ctx?.tool?.hook) {
        await ctx.tool.hook('execute.before', (event) => { void hooks.onToolBefore(event) })
        await ctx.tool.hook('execute.after', (event) => { void hooks.onToolAfter(event) })
      }
    } catch {}

    try {
      if (ctx?.permission?.hook) {
        await ctx.permission.hook('evaluate', (event) => hooks.onPermission(event))
      }
    } catch {}

    return () => controller.abort()
  },

  /** OpenCode 1.x: called as default.server(ctx) → hooks object */
  async server(ctx) {
    return v1HookObject(createHooks(ctx))
  },
}

/** Legacy named export (V1 function style). */
export async function AgentOfficePlugin(ctx) {
  return v1HookObject(createHooks(ctx))
}
