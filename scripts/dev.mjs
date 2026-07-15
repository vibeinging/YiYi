import { execFileSync, spawn } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'
import { existsSync } from 'node:fs'

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const CUSTOM_RENDERER_URL = process.env.YIW_DEV_URL
const NATIVE_NPM_SCRIPT = join(APP_DIR, 'scripts', 'native-npm.mjs')

function resolveRendererPort() {
  const explicitPort = Number(process.env.YIW_RENDERER_PORT)
  if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort
  return 57131
}

let RENDERER_PORT = resolveRendererPort()
let RENDERER_URL = CUSTOM_RENDERER_URL || `http://127.0.0.1:${RENDERER_PORT}`
const SERVER_NATIVE_SQLITE = join(APP_DIR, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')

const children = new Set()
let shuttingDown = false
const CHILD_GRACEFUL_SHUTDOWN_MS = 8000
const CHILD_FORCE_SHUTDOWN_MS = 1500

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function fetchText(url, timeoutMs = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

async function isRendererHealthy(port) {
  const baseUrl = `http://127.0.0.1:${port}`
  const [entry, svgRegister] = await Promise.all([
    fetchText(`${baseUrl}/src/main.tsx`),
    fetchText(`${baseUrl}/@id/virtual:svg-icons-register`)
  ])
  return (
    entry.includes('/@id/virtual:svg-icons-register')
    && svgRegister.includes('__svg__icons__dom__')
    && svgRegister.includes('loadSvg')
  )
}

async function findFreePort(startPort, attempts = 50) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    if (!(await isPortOpen(port))) return port
  }
  throw new Error(`找不到可用 renderer 端口(从 ${startPort} 起试了 ${attempts} 个)`)
}

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  children.add(child)
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && options.exitOnClose) {
      void shutdown(code ?? (signal ? 1 : 0))
    }
  })
  child.once('error', (error) => {
    console.error(`[dev] ${name} 启动失败: ${error.message}`)
    if (options.exitOnClose) void shutdown(1)
  })
  return child
}

function nativeArch(filePath) {
  if (!existsSync(filePath)) return ''
  try {
    const out = execFileSync('file', [filePath], { encoding: 'utf8' })
    if (out.includes('arm64')) return 'arm64'
    if (out.includes('x86_64')) return 'x64'
  } catch {
    // ignore
  }
  return ''
}

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function resolveBackendNode() {
  if (process.env.YIW_NODE_BIN && existsSync(process.env.YIW_NODE_BIN)) return process.env.YIW_NODE_BIN
  const targetArch = nativeArch(SERVER_NATIVE_SQLITE)
  if (!targetArch) return process.execPath
  const candidates = [
    process.execPath,
    ...String(process.env.PATH || '').split(delimiter).map((dir) => join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((p, i, arr) => p && existsSync(p) && arr.indexOf(p) === i)
  return candidates.find((p) => nodeArch(p) === targetArch) || process.execPath
}

function waitForChildExit(child, timeoutMs) {
  if (!children.has(child) || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

async function stopChild(child) {
  if (!children.has(child)) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
  if (await waitForChildExit(child, CHILD_GRACEFUL_SHUTDOWN_MS)) return
  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
  await waitForChildExit(child, CHILD_FORCE_SHUTDOWN_MS)
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([...children].map((child) => stopChild(child)))
  process.exit(code)
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

const rendererPortOpen = CUSTOM_RENDERER_URL ? true : await isPortOpen(RENDERER_PORT)
const rendererAlreadyRunning = CUSTOM_RENDERER_URL ? true : rendererPortOpen && await isRendererHealthy(RENDERER_PORT)

if (CUSTOM_RENDERER_URL) {
  console.log(`[dev] 使用 YIW_DEV_URL: ${RENDERER_URL}`)
} else if (!rendererAlreadyRunning) {
  if (rendererPortOpen) {
    const nextPort = await findFreePort(RENDERER_PORT + 1)
    console.warn(`[dev] renderer ${RENDERER_URL} 未通过健康检查，改用 http://127.0.0.1:${nextPort}`)
    RENDERER_PORT = nextPort
    RENDERER_URL = `http://127.0.0.1:${RENDERER_PORT}`
  }
  run('renderer', process.execPath, [NATIVE_NPM_SCRIPT, 'run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: join(APP_DIR, 'renderer'),
    env: { VITE_APP_DEV_PORT: String(RENDERER_PORT), VITE_DEV_PORT: String(RENDERER_PORT) }
  })
  const ready = await waitForPort(RENDERER_PORT)
  if (!ready) {
    console.error(`[dev] renderer 未能在 ${RENDERER_PORT} 端口启动`)
    await shutdown(1)
  }
} else {
  console.log(`[dev] renderer 已在 ${RENDERER_URL} 运行，复用现有服务`)
}

run('electron', process.execPath, [NATIVE_NPM_SCRIPT, 'run', 'dev'], {
  cwd: join(APP_DIR, 'electron'),
  env: { YIW_DEV_URL: RENDERER_URL, YIW_NODE_BIN: resolveBackendNode() },
  exitOnClose: true
})
