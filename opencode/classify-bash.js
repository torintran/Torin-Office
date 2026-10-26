/**
 * Lightweight Bash signal classifier for OpenCode bash tool calls.
 * Emits the same kind strings as hooks/agent-tracker.sh Signals.
 */

const TEST_RE = /\b(npm\s+test|npm\s+run\s+test\b|pnpm\s+test|yarn\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|playwright\s+test|rspec|phpunit)\b/i
const BUILD_RE = /\b(npm\s+run\s+build\b|pnpm\s+(?:run\s+)?build|yarn\s+build|vite\s+build|tsc\b|next\s+build|cargo\s+build|go\s+build|docker\s+build|webpack|esbuild|make\b|gradle\b|mvn\s+package)\b/i
const DEPLOY_RE = /\b(vercel\s+deploy|netlify\s+deploy|fly\s+deploy|railway\s+up|kubectl\s+(?:apply|rollout)|helm\s+(?:upgrade|install)|terraform\s+apply|pulumi\s+up|cdk\s+deploy|wrangler\s+deploy|firebase\s+deploy|npm\s+publish|gh\s+release\s+create|docker\s+push)\b/i
const PUSH_RE = /\bgit\s+push\b/i
const DRY_RUN = /--dry-run\b/

/**
 * @param {string} command
 * @param {'start'|'ok'|'fail'} phase
 * @returns {Array<{kind: string, target?: string, branch?: string, toDefault?: boolean}>}
 */
export function classifyBash(command, phase = 'start') {
  if (!command || typeof command !== 'string' || DRY_RUN.test(command)) return []
  const cmd = command.trim()
  const signals = []

  if (DEPLOY_RE.test(cmd)) {
    const kind = phase === 'start' ? 'deploy_start' : phase === 'ok' ? 'deploy_success' : 'deploy_fail'
    signals.push({ kind, target: guessTarget(cmd) })
  } else if (TEST_RE.test(cmd)) {
    const kind = phase === 'start' ? 'test_start' : phase === 'ok' ? 'test_ok' : 'test_failed'
    signals.push({ kind, target: guessTarget(cmd) })
  } else if (BUILD_RE.test(cmd)) {
    const kind = phase === 'start' ? 'build_start' : phase === 'ok' ? 'build_ok' : 'build_failed'
    signals.push({ kind, target: guessTarget(cmd) })
  } else if (PUSH_RE.test(cmd)) {
    const branch = guessBranch(cmd)
    const toDefault = branch === 'main' || branch === 'master'
    if (phase === 'start') signals.push({ kind: 'push', branch, toDefault })
    else if (phase === 'ok') signals.push({ kind: 'push_done', branch, toDefault })
    else signals.push({ kind: 'push_failed', branch, toDefault })
  }
  return signals
}

function guessTarget(cmd) {
  const m = cmd.match(/(?:--name[= ]+|\/)([A-Za-z0-9._-]{2,40})/)
  return m ? m[1] : undefined
}

function guessBranch(cmd) {
  const m = cmd.match(/\bgit\s+push\b(?:\s+\S+)?\s+(\S+)/)
  if (!m) return undefined
  const ref = m[1]
  if (ref.startsWith('-')) return undefined
  return ref.includes(':') ? ref.split(':').pop() : ref
}
