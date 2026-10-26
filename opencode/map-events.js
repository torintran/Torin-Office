/**
 * Pure mapper: OpenCode plugin events → Agent Office POST /event payloads.
 *
 * Child sessions (task tool / parentID) become workers, not session pills.
 */

import { roleFor, nameFor } from './roles.js'
import { classifyBash } from './classify-bash.js'

export const CONNECTION = 'opencode'

/**
 * @typedef {object} BridgeState
 * @property {Map<string, Set<string>>} parentToChildren
 * @property {Map<string, string>} childToParent
 * @property {Map<string, object>} pendingTaskByCall
 * @property {Map<string, string>} cwdBySession
 * @property {Map<string, string>} projectBySession
 * @property {Map<string, Map<string, string>>} lastTodos
 * @property {Map<string, string>} messageRole          messageID → user|assistant
 * @property {Map<string, string>} assistantTextBySession sessionID → last/partial reply
 * @property {Map<string, string>} userTextBySession     sessionID → last user prompt text
 * @property {Set<string>} promptedMessageIds            user messageIDs already emitted as session_prompt
 */

/** Chat-AI / generate sessions must not seat a desk in the office. */
export function isOfficeBotTitle(title) {
  return /^agent-office-bot$/i.test(String(title || '').trim())
}

/** @returns {BridgeState} */
export function createBridgeState() {
  return {
    parentToChildren: new Map(),
    childToParent: new Map(),
    pendingTaskByCall: new Map(),
    cwdBySession: new Map(),
    projectBySession: new Map(),
    lastTodos: new Map(),
    messageRole: new Map(),
    assistantTextBySession: new Map(),
    userTextBySession: new Map(),
    promptedMessageIds: new Set(),
    /** @type {Set<string>} session IDs from opencode run --title agent-office-bot */
    ignoredSessions: new Set(),
    /** @type {Set<string>} parent sessions waiting for a title before seating a desk */
    pendingUntitled: new Set(),
  }
}

function rememberAssistant(state, sessionID, text) {
  if (!sessionID || !text) return
  const officeId = officeSessionId(state, sessionID) || sessionID
  if (isChild(state, sessionID)) return
  const prev = state.assistantTextBySession.get(officeId) || ''
  // Prefer longer / newer full text over a short prefix
  if (text.length >= prev.length) state.assistantTextBySession.set(officeId, text.slice(0, 2000))
}

function appendAssistantDelta(state, sessionID, delta) {
  if (!sessionID || !delta) return
  const officeId = officeSessionId(state, sessionID) || sessionID
  if (isChild(state, sessionID)) return
  const prev = state.assistantTextBySession.get(officeId) || ''
  state.assistantTextBySession.set(officeId, (prev + delta).slice(0, 2000))
}

function takeAssistantReply(state, sessionID) {
  const officeId = officeSessionId(state, sessionID) || sessionID
  const text = state.assistantTextBySession.get(officeId) || ''
  state.assistantTextBySession.delete(officeId)
  return text
}

function basename(p) {
  if (!p || typeof p !== 'string') return undefined
  const clean = p.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean
}

function officeSessionId(state, sessionID) {
  if (!sessionID) return null
  return state.childToParent.get(sessionID) || sessionID
}

function isChild(state, sessionID) {
  return !!(sessionID && state.childToParent.has(sessionID))
}

function sessionMeta(state, sessionID, directory) {
  const officeId = officeSessionId(state, sessionID) || sessionID
  if (directory) {
    state.cwdBySession.set(officeId, directory)
    state.projectBySession.set(officeId, basename(directory))
  }
  const cwd = state.cwdBySession.get(officeId)
  const project = state.projectBySession.get(officeId) || (cwd ? basename(cwd) : undefined)
  return {
    sessionId: officeId,
    connection: CONNECTION,
    ...(cwd ? { cwd, project } : {}),
  }
}

function registerChild(state, childId, parentId) {
  if (!childId || !parentId || childId === parentId) return
  state.childToParent.set(childId, parentId)
  let set = state.parentToChildren.get(parentId)
  if (!set) {
    set = new Set()
    state.parentToChildren.set(parentId, set)
  }
  set.add(childId)
}

function unregisterChild(state, childId) {
  const parent = state.childToParent.get(childId)
  if (!parent) return
  state.childToParent.delete(childId)
  state.parentToChildren.get(parent)?.delete(childId)
}

function toolStatus(tool, args) {
  const t = String(tool || 'tool')
  if (!args || typeof args !== 'object') return `⚡ ${t}`
  if (t === 'bash' && args.command) return `⚡ bash: ${String(args.command).slice(0, 80)}`
  if (t === 'read' && args.filePath) return `📖 ${String(args.filePath).slice(0, 80)}`
  if (t === 'edit' && args.filePath) return `✏️ ${String(args.filePath).slice(0, 80)}`
  if (t === 'write' && args.filePath) return `📝 ${String(args.filePath).slice(0, 80)}`
  if (t === 'task' && args.description) return `🤝 ${String(args.description).slice(0, 80)}`
  return `⚡ ${t}`
}

function agentIdForTool(state, sessionID) {
  if (isChild(state, sessionID)) return sessionID
  return undefined
}

/**
 * Map a bus `event` callback payload to office events.
 * @param {BridgeState} state
 * @param {{ type: string, properties?: any }} event
 * @returns {object[]}
 */
function sessionIdFromProps(props) {
  return props?.info?.id
    || props?.sessionID
    || props?.sessionId
    || props?.part?.sessionID
    || props?.info?.sessionID
    || null
}

/** Seat a deferred untitled session once real work starts (interactive CLI). */
function flushUntitledStart(state, sessionID) {
  if (!sessionID || !state.pendingUntitled.has(sessionID)) return []
  if (state.ignoredSessions.has(sessionID)) {
    state.pendingUntitled.delete(sessionID)
    return []
  }
  state.pendingUntitled.delete(sessionID)
  return [{
    type: 'session_started',
    source: 'startup',
    ...sessionMeta(state, sessionID),
  }]
}

export function mapBusEvent(state, event) {
  if (!event || typeof event.type !== 'string') return []
  const props = event.properties || {}
  const maybeSid = sessionIdFromProps(props) || props.sessionID || props.sessionId
  if (maybeSid && state.ignoredSessions.has(maybeSid)) return []

  switch (event.type) {
    case 'session.created': {
      const info = props.info || {}
      const id = info.id
      if (!id) return []
      // opencode run --title agent-office-bot (chat AI) — do not seat a desk
      if (isOfficeBotTitle(info.title)) {
        state.ignoredSessions.add(id)
        return []
      }
      if (info.parentID) {
        registerChild(state, id, info.parentID)
        const meta = sessionMeta(state, info.parentID, info.directory)
        const pending = [...state.pendingTaskByCall.values()].find(
          (p) => p.parentSessionId === info.parentID && !p.linked,
        )
        const out = []
        if (pending) {
          pending.linked = true
          pending.childId = id
          out.push({
            type: 'agent_linked',
            agentId: pending.officeId,
            subagentId: id,
            ...meta,
          })
        }
        out.push({
          type: 'agent_started',
          subagentId: id,
          agentType: pending?.agentType || 'general-purpose',
          ...meta,
        })
        return out
      }
      const meta = sessionMeta(state, id, info.directory)
      // Title often arrives on session.updated — wait so chat-AI bots never clock in
      if (!info.title) {
        state.pendingUntitled.add(id)
        return []
      }
      return [{
        type: 'session_started',
        source: 'startup',
        title: String(info.title).slice(0, 120),
        ...meta,
      }]
    }

    case 'session.deleted': {
      const info = props.info || {}
      const id = info.id || props.sessionID || props.sessionId
      if (!id) return []
      if (state.ignoredSessions.has(id)) {
        state.ignoredSessions.delete(id)
        return []
      }
      if (isChild(state, id)) {
        const meta = sessionMeta(state, id)
        unregisterChild(state, id)
        return [{ type: 'agent_completed', agentId: id, result: 'subagent session ended', ...meta }]
      }
      // Complete remaining children then end parent
      const kids = [...(state.parentToChildren.get(id) || [])]
      const out = []
      const meta = sessionMeta(state, id)
      for (const kid of kids) {
        out.push({ type: 'agent_completed', agentId: kid, result: 'parent session ended', ...meta })
        unregisterChild(state, kid)
      }
      out.push({ type: 'session_ended', reason: 'other', ...meta })
      return out
    }

    case 'session.idle': {
      const sid = props.sessionID || props.sessionId
      if (!sid) return []
      if (state.ignoredSessions.has(sid)) return []
      if (isChild(state, sid)) {
        // Child idle: complete worker (fallback if task.after missed)
        return [{
          type: 'agent_completed',
          agentId: sid,
          result: 'idle',
          ...sessionMeta(state, sid),
        }]
      }
      const started = flushUntitledStart(state, sid)
      const reply = takeAssistantReply(state, sid)
      return [...started, { type: 'session_turn_end', text: reply, ...sessionMeta(state, sid) }]
    }

    case 'session.error': {
      const sid = props.sessionID
      if (!sid || isChild(state, sid)) return []
      const err = props.error
      const label = err?.name || err?.data?.message || 'error'
      const detail = err?.data?.message || err?.message || undefined
      return [{
        type: 'session_error',
        error: String(label).slice(0, 40),
        detail: detail ? String(detail).slice(0, 200) : undefined,
        ...sessionMeta(state, sid),
      }]
    }

    case 'session.compacted': {
      const sid = props.sessionID
      if (!sid || isChild(state, sid)) return []
      const meta = sessionMeta(state, sid)
      return [
        { type: 'session_compact', phase: 'pre', trigger: 'auto', ...meta },
        { type: 'session_compact', phase: 'post', trigger: 'auto', ...meta },
      ]
    }

    case 'session.updated': {
      const info = props.info || {}
      if (!info.id || info.parentID || isChild(state, info.id)) return []
      if (isOfficeBotTitle(info.title)) {
        state.ignoredSessions.add(info.id)
        state.pendingUntitled.delete(info.id)
        // If we already seated (legacy path), clock out; otherwise stay silent
        return [{ type: 'session_ended', reason: 'other', ...sessionMeta(state, info.id, info.directory) }]
      }
      if (state.ignoredSessions.has(info.id)) return []
      const meta = sessionMeta(state, info.id, info.directory)
      const out = []
      if (info.directory && meta.cwd) out.push({ type: 'session_cwd', cwd: meta.cwd, project: meta.project, ...meta })
      if (state.pendingUntitled.has(info.id) && info.title) {
        state.pendingUntitled.delete(info.id)
        out.push({
          type: 'session_started',
          source: 'startup',
          title: String(info.title).slice(0, 120),
          ...meta,
        })
      }
      return out
    }

    case 'message.updated': {
      const info = props.info || {}
      if (!info.sessionID || !info.id) return []
      if (isChild(state, info.sessionID)) return []
      if (info.role) state.messageRole.set(info.id, info.role)

      if (info.role === 'user') {
        const text = info.summary?.title || info.summary?.body || state.userTextBySession.get(info.sessionID) || ''
        if (!text || state.promptedMessageIds.has(info.id)) {
          return flushUntitledStart(state, info.sessionID)
        }
        state.promptedMessageIds.add(info.id)
        return [
          ...flushUntitledStart(state, info.sessionID),
          {
            type: 'session_prompt',
            text: String(text).slice(0, 2000),
            promptId: info.id,
            ...sessionMeta(state, info.sessionID),
          },
        ]
      }

      if (info.role === 'assistant') {
        // Clear previous turn's buffer when a new assistant message starts
        const officeId = officeSessionId(state, info.sessionID) || info.sessionID
        if (!state.assistantTextBySession.has(officeId)) {
          state.assistantTextBySession.set(officeId, '')
        }
      }
      return []
    }

    case 'message.part.updated': {
      const part = props.part || {}
      const sid = part.sessionID
      if (!sid || isChild(state, sid)) return []
      if (part.type !== 'text') return []

      const role = state.messageRole.get(part.messageID)
      const text = typeof part.text === 'string' ? part.text : ''
      const delta = typeof props.delta === 'string' ? props.delta : ''
      const officeId = officeSessionId(state, sid) || sid

      if (role === 'user') {
        if (text) state.userTextBySession.set(officeId, text.slice(0, 2000))
        if (text && part.messageID && !state.promptedMessageIds.has(part.messageID)) {
          state.promptedMessageIds.add(part.messageID)
          return [
            ...flushUntitledStart(state, sid),
            {
              type: 'session_prompt',
              text: text.slice(0, 2000),
              promptId: part.messageID,
              ...sessionMeta(state, sid),
            },
          ]
        }
        return flushUntitledStart(state, sid)
      }

      // assistant or role not yet known — always accumulate for session_turn_end
      if (role !== 'user') {
        if (delta) appendAssistantDelta(state, sid, delta)
        else if (text) rememberAssistant(state, sid, text)
      }
      return []
    }

    case 'permission.updated':
    case 'permission.asked': {
      const p = props.id ? props : (props.permission || props)
      if (!p?.sessionID) return []
      if (isChild(state, p.sessionID)) return []
      return [{
        type: 'session_needs_you',
        kind: 'permission',
        answerable: false,
        toolName: p.type || 'tool',
        summary: p.title || undefined,
        detail: typeof p.metadata?.command === 'string' ? p.metadata.command : (p.title || undefined),
        callKey: p.callID || p.id,
        ...sessionMeta(state, p.sessionID),
      }]
    }

    case 'todo.updated': {
      const sid = props.sessionID
      if (!sid || isChild(state, sid)) return []
      const todos = Array.isArray(props.todos) ? props.todos : []
      const prev = state.lastTodos.get(sid) || new Map()
      const next = new Map()
      const out = []
      const meta = sessionMeta(state, sid)
      for (const t of todos) {
        if (!t?.id) continue
        const status = String(t.status || 'pending')
        next.set(t.id, status)
        const was = prev.get(t.id)
        if (status === 'completed' && was !== 'completed') {
          out.push({ type: 'task_completed', taskId: String(t.id).slice(0, 40), subject: String(t.content || '').slice(0, 120), ...meta })
        } else if (!was) {
          out.push({ type: 'task_created', taskId: String(t.id).slice(0, 40), subject: String(t.content || '').slice(0, 120), ...meta })
        }
      }
      state.lastTodos.set(sid, next)
      return out
    }

    default:
      return []
  }
}

/**
 * Map tool.execute.before → office events.
 * @param {BridgeState} state
 * @param {{ tool: string, sessionID: string, callID: string }} input
 * @param {{ args?: any }} output
 */
export function mapToolBefore(state, input, output = {}) {
  const tool = input?.tool
  const sessionID = input?.sessionID
  if (!tool || !sessionID) return []
  const args = output.args || {}
  const meta = sessionMeta(state, sessionID)
  const agentId = agentIdForTool(state, sessionID)

  if (tool === 'task') {
    const description = String(args.description || args.prompt || 'task').slice(0, 120)
    const subType = String(args.subagent_type || args.subagentType || 'general-purpose')
    const role = roleFor(subType, description)
    const officeId = `oc-task-${input.callID || randomId()}`
    state.pendingTaskByCall.set(input.callID || officeId, {
      officeId,
      parentSessionId: officeSessionId(state, sessionID),
      agentType: role,
      description,
      linked: false,
    })
    const parentSub = isChild(state, sessionID) ? sessionID : undefined
    return [{
      type: 'agent_spawned',
      agent: {
        id: officeId,
        name: nameFor(role),
        role,
        task: description,
        agentType: role,
        background: true,
        ...(parentSub ? { parentSubagentId: parentSub } : {}),
      },
      ...meta,
    }]
  }

  const status = toolStatus(tool, args)
  const events = [{
    type: 'agent_working',
    status,
    ...(agentId ? { agentId } : {}),
    ...meta,
  }]

  if (tool === 'bash' && args.command) {
    const signals = classifyBash(String(args.command), 'start')
    if (signals.length) events[0].signals = signals
  }
  return events
}

/**
 * Map tool.execute.after → office events.
 */
export function mapToolAfter(state, input, output = {}) {
  const tool = input?.tool
  const sessionID = input?.sessionID
  if (!tool || !sessionID) return []
  const args = input.args || output.args || {}
  const meta = sessionMeta(state, sessionID)
  const agentId = agentIdForTool(state, sessionID)
  const failed = !!(output.metadata?.error || output.error)
  const outText = typeof output.output === 'string' ? output.output : ''

  if (tool === 'task') {
    const pending = state.pendingTaskByCall.get(input.callID)
    state.pendingTaskByCall.delete(input.callID)
    const childId =
      pending?.childId ||
      output.metadata?.sessionId ||
      output.metadata?.sessionID ||
      null
    if (childId && pending?.parentSessionId) {
      registerChild(state, childId, pending.parentSessionId)
    }
    const id = childId || pending?.officeId
    if (!id) return []
    // Link office spawn id to child session id when we learn it
    if (childId && pending?.officeId && childId !== pending.officeId) {
      return [
        { type: 'agent_linked', agentId: pending.officeId, subagentId: childId, ...meta },
        {
          type: 'agent_completed',
          agentId: childId,
          result: String(outText || output.title || 'done').slice(0, 2000),
          ...meta,
        },
      ]
    }
    return [{
      type: 'agent_completed',
      agentId: id,
      result: String(outText || output.title || 'done').slice(0, 2000),
      ...meta,
    }]
  }

  const events = []
  if (failed) {
    events.push({
      type: 'agent_working',
      status: `failed: ${tool}`,
      failed: true,
      ...(agentId ? { agentId } : {}),
      ...meta,
    })
  }

  const done = {
    type: 'session_tool_done',
    toolName: String(tool).slice(0, 80),
    callKey: input.callID,
    ...(agentId ? { agentId } : {}),
    ...meta,
  }
  if (tool === 'bash' && args.command) {
    const signals = classifyBash(String(args.command), failed ? 'fail' : 'ok')
    if (signals.length) done.signals = signals
  }
  events.push(done)
  return events
}

/**
 * Map permission.ask → office session_needs_you (answerable).
 */
export function mapPermissionAsk(state, permission, { nonce, answerable = true } = {}) {
  if (!permission?.sessionID) return []
  if (isChild(state, permission.sessionID)) return []
  const detail =
    (typeof permission.metadata?.command === 'string' && permission.metadata.command) ||
    permission.title ||
    permission.type ||
    'permission'
  return [{
    type: 'session_needs_you',
    kind: 'permission',
    answerable: !!answerable,
    toolName: String(permission.type || 'tool').slice(0, 80),
    summary: permission.title ? String(permission.title).slice(0, 200) : undefined,
    detail: String(detail).slice(0, 400),
    callKey: permission.callID || permission.id,
    ...(nonce ? { nonce } : {}),
    ...sessionMeta(state, permission.sessionID),
  }]
}

function randomId() {
  return Math.random().toString(36).slice(2, 10)
}
