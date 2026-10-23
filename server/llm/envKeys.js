/**
 * Resolve API keys from process.env then local .env files.
 * Never logs secret values. Re-reads files on every call.
 *
 * Order: process.env[name] → $AGENT_OFFICE_HOME/.env → ~/.env
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * @param {string} [home]
 * @param {string} [officeHome]
 */
export function envFilePaths(home = homedir(), officeHome = process.env.AGENT_OFFICE_HOME || join(home, '.agent-office')) {
  return [
    join(officeHome, '.env'),
    join(home, '.env'),
  ]
}

/**
 * Parse KEY=value lines. Skips blanks and # comments.
 * Supports optional surrounding quotes on values.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (value === '') continue // present but empty → treat as unset
    out[key] = value
  }
  return out
}

/**
 * @param {string} name
 * @param {{ home?: string, officeHome?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string|null}
 */
export function resolveApiKey(name, opts = {}) {
  if (!name || typeof name !== 'string') return null
  const env = opts.env || process.env
  const fromEnv = env[name]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

  const home = opts.home ?? homedir()
  const officeHome = opts.officeHome ?? (env.AGENT_OFFICE_HOME || join(home, '.agent-office'))
  for (const path of envFilePaths(home, officeHome)) {
    if (!existsSync(path)) continue
    try {
      const map = parseEnvFile(readFileSync(path, 'utf8'))
      const v = map[name]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    } catch {
      // ignore unreadable files
    }
  }
  return null
}

/**
 * Hint for UI/doctor when a required key is missing (never includes the secret).
 * @param {string} apiKeyEnv
 */
export function missingKeyHint(apiKeyEnv) {
  return `Missing ${apiKeyEnv}. Run: export ${apiKeyEnv}="your-key" before starting, or add it to ~/.agent-office/.env`
}
