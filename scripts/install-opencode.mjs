#!/usr/bin/env node
/**
 * install-opencode.mjs — copy the Agent Office OpenCode plugin into the
 * global OpenCode plugins directory (~/.config/opencode/plugins/agent-office).
 *
 * OpenCode 2.x only loads plugin *directories* (not bare .js files). Safe to re-run.
 */

import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'opencode')

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
const legacyShim = join(destDir, 'agent-office.js')

if (!existsSync(SRC)) {
  console.error(`install-opencode: missing ${SRC}`)
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })

// OpenCode 2 rejects bare .js plugin files — remove the old V1 shim if present
if (existsSync(legacyShim)) {
  rmSync(legacyShim, { force: true })
  console.log(`removed legacy shim ${legacyShim}`)
}

if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
cpSync(SRC, pluginDir, { recursive: true })

// Do NOT also add to opencode.json — OpenCode auto-discovers ~/.config/opencode/plugins/*
// and a duplicate config entry would load the bridge twice (double agents in the office).
const cfgPathJson = join(configDir(), 'opencode.json')
if (existsSync(cfgPathJson)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPathJson, 'utf8'))
    const list = Array.isArray(cfg.plugins) ? cfg.plugins : []
    const next = list.filter((p) => {
      if (typeof p === 'string') return !p.includes('agent-office')
      if (p && typeof p === 'object') return !String(p.package || '').includes('agent-office')
      return true
    })
    if (next.length !== list.length) {
      cfg.plugins = next
      writeFileSync(cfgPathJson, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      console.log(`cleaned duplicate agent-office from ${cfgPathJson} (directory discovery is enough)`)
    }
  } catch {}
}

console.log(`OpenCode plugin installed:`)
console.log(`  ${pluginDir}`)
console.log(``)
console.log(`This is NOT an LLM provider.`)
console.log(`1. Start the office:  npm run server   (and npm run open -- --dev)`)
console.log(`2. Restart OpenCode (new session)`)
console.log(`3. Work in OpenCode as usual — agents appear in the office labelled OpenCode`)
