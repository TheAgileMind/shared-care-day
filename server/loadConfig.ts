import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { EXAMPLE_CONFIG, validateConfig, type AppConfig } from '../src/lib/config.ts'

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** Reads household config, then applies APP_TIMEZONE (IANA name) if set. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = repoRoot()): AppConfig {
  const base = readConfigFile(env, root)
  const zone = (env.APP_TIMEZONE || '').trim()
  return zone ? validateConfig({ ...base, timezone: zone }) : base
}

function readConfigFile(env: NodeJS.ProcessEnv, root: string): AppConfig {
  const configured = env.CONFIG_PATH
  const candidates = [
    configured,
    path.join(root, 'config.json'),
    path.join(root, 'config.example.json'),
  ].filter((p): p is string => !!p)
  for (const file of candidates) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(root, file)
    if (!fs.existsSync(resolved)) continue
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
    return validateConfig(parsed)
  }
  return EXAMPLE_CONFIG
}
