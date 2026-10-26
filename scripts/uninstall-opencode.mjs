#!/usr/bin/env node
/**
 * uninstall-opencode.mjs — remove the Agent Office OpenCode plugin.
 */

import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function pluginsDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return join(process.env.OPENCODE_CONFIG_DIR, 'plugins')
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  return join(home, '.config', 'opencode', 'plugins')
}

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  return join(home, '.config', 'opencode')
}

const destDir = pluginsDir()
const pluginDir = join(destDir, 'agent-office')
const shimPath = join(destDir, 'agent-office.js')

let removed = 0
for (const p of [pluginDir, shimPath]) {
  if (!existsSync(p)) continue
  rmSync(p, { recursive: true, force: true })
  console.log(`removed ${p}`)
  removed++
}

const cfgPath = join(configDir(), 'opencode.json')
if (existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const list = Array.isArray(cfg.plugins) ? cfg.plugins : []
    const next = list.filter((p) => {
      if (typeof p === 'string') return !p.includes('agent-office')
      if (p && typeof p === 'object') return !String(p.package || '').includes('agent-office')
      return true
    })
    if (next.length !== list.length) {
      cfg.plugins = next
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      console.log(`updated ${cfgPath}`)
    }
  } catch (err) {
    console.warn(`could not update opencode.json: ${err.message}`)
  }
}

if (!removed) {
  console.log(`nothing to remove under ${destDir}`)
} else {
  console.log(`OpenCode plugin uninstalled (${removed} path(s)). Restart OpenCode to finish.`)
}
