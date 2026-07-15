import { execFileSync, spawn } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import process from 'node:process'

function machineArch() {
  if (process.platform !== 'darwin') return process.arch
  try {
    const arm64Capable = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim()
    if (arm64Capable === '1') return 'arm64'
    const arch = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim()
    return arch === 'arm64' ? 'arm64' : arch === 'x86_64' ? 'x64' : process.arch
  } catch {
    return process.arch
  }
}

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function resolveNativeNode() {
  const targetArch = machineArch()
  const candidates = [
    process.execPath,
    ...String(process.env.PATH || '').split(delimiter).map((dir) => join(dir, process.platform === 'win32' ? 'node.exe' : 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((path, index, all) => path && existsSync(path) && all.indexOf(path) === index)

  return candidates.find((path) => nodeArch(path) === targetArch) || process.execPath
}

const nativeNode = resolveNativeNode()
const binDir = dirname(nativeNode)
const npmCommand = join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')

if (!existsSync(npmCommand)) {
  console.error(`[native-npm] 找不到与 ${nativeNode} 配套的 npm`)
  process.exit(1)
}

const child = spawn(npmCommand, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
  },
})

child.once('error', (error) => {
  console.error(`[native-npm] 启动失败: ${error.message}`)
  process.exit(1)
})
child.once('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
