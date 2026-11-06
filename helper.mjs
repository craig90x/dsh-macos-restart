/**
 * dsh-macos-restart —— detached helper。
 *
 * 由宿主用 `ELECTRON_RUN_AS_NODE=1` + `detached: true` 拉起，因此不依赖系统
 * Node、不依赖 PATH，而且能活过宿主与 Electron 主进程的死亡。整件事由它做完：
 *
 *   1. 等一小会儿，让 RPC 响应先送达浏览器；
 *   2. `osascript ... to quit` 优雅退出；
 *   3. macOS 的「确认退出」是宿主自己弹的原生框（inspectQuit 报告有进行中/已排程
 *      任务时必弹），远程无法点击 —— 等 `dialogWaitMs` 仍未退出就先 SIGTERM；
 *      Chromium 的 browser 进程会捕获 SIGTERM 转成优雅退出，于是又落回同一个框，
 *      所以 SIGTERM 无效时再按配置升级到 SIGKILL（唯一能让远程重启不被框卡住的方式，
 *      代价是当前未落盘的一轮会话内容可能丢失）；
 *   4. 等主进程消失、整棵 bundle 进程树消失（否则 launchservicesd 仍认为
 *      "应用在运行"，新实例会被系统立刻回收 —— 这是 v0.1.1 的真实事故）；
 *   5. spawn 与 `open -n` 交替重试重新拉起，每次等 3.5 秒确认没被秒收，最多
 *      `relaunchTimeoutMs`（默认 30s，需跨过旧实例退出后约 15 秒的系统回收窗口）；
 *   6. 结果写日志（~/.dsh/logs/macos-restart.log）并发系统通知；删锁。
 *
 * 用法：node helper.mjs <handoff.json>
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const handoff = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const LOG_PATH = handoff.logPath
const APP_PATH = handoff.appPath
const APP_NAME = handoff.appName ?? path.basename(APP_PATH, '.app')
const EXE_PATH = `${APP_PATH}/Contents/MacOS/${APP_NAME}`
const DIALOG_WAIT_MS = Number.isFinite(handoff.dialogWaitMs) ? handoff.dialogWaitMs : 6000
// SIGTERM 在确认框存在时无效：Electron/Chromium 的 browser 进程自己装了 SIGTERM 处理器，
// 会把它转成优雅退出 → 又落回同一个被原生框卡住的 before-quit。实测（v0.1.3）发出 SIGTERM
// 后主进程 25 秒仍活着、框还在。因此这里在 SIGTERM 短等之后再上 SIGKILL。
const SIGTERM_WAIT_MS = 5000
const SIGKILL_WAIT_MS = 10000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [helper] ${line}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

/** 去掉 node 模式相关的环境变量，否则新实例会被当成 Node 进程而不是 GUI 应用。 */
function guiEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/** bundle 内所有进程（含 Electron 的 GPU/Renderer/Helper 与宿主 node 子进程），排除自己。 */
function bundlePids() {
  let out
  try {
    out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 6000, maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return []
  }
  const prefix = `${APP_PATH}/Contents/`
  const result = []
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[3]
    if (pid === process.pid || command.includes('helper.mjs')) continue
    if (!command.includes(prefix)) continue
    result.push({ pid, ppid: Number(match[2]), command })
  }
  return result
}

/** 新主进程 = bundle 可执行体本身（排除 --expose-internals 的宿主与各类 Helper）。 */
function findNewMainPid(baseline) {
  for (const entry of bundlePids()) {
    if (baseline.has(entry.pid)) continue
    if (!entry.command.startsWith(EXE_PATH)) continue
    if (entry.command.includes('--expose-internals') || entry.command.includes('--type=')) continue
    return entry.pid
  }
  return null
}

function notify(message) {
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "DSH 重启"`], { timeout: 5000, stdio: 'ignore' })
  } catch {
    // 通知失败忽略
  }
}

function cleanup() {
  try {
    fs.rmSync(handoff.lockPath, { force: true })
  } catch {
    // ignore
  }
  try {
    fs.rmSync(process.argv[2], { force: true })
  } catch {
    // ignore
  }
}

function abort(reason) {
  log(`ABORT: ${reason}`)
  notify(`重启失败：${reason}`)
  cleanup()
  process.exit(1)
}

/**
 * 重新拉起应用并确认是「新实例」。
 *
 * 实测（v0.1.2）：旧实例退出后的约 15 秒内，同 bundle 的新实例会被系统立刻回收
 * （v0.1.1 的 `open -n` 连试 4 次、本次实测直接 spawn 连试 3 次，日志都是
 * "died during startup"），跨过这个窗口后两种方式都能成功。因此这里不再赌单一
 * 方式：spawn 与 `open -n` 交替重试，直到 relaunchTimeoutMs（默认 30s）用完。
 *
 * @param {Set<number>} baseline 重启前的 bundle 进程 pid
 * @returns {Promise<number | null>} 新主进程 pid
 */
async function relaunch(baseline) {
  const clear = await waitUntil(() => bundlePids().length === 0, 15000, 300)
  if (!clear) {
    const survivors = bundlePids().map((p) => p.pid)
    log(`bundle pids still alive before relaunch: ${survivors.join(',')} — sending SIGKILL`)
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
    await waitUntil(() => bundlePids().length === 0, 5000, 200)
  }

  const deadline = Date.now() + (Number.isFinite(handoff.relaunchTimeoutMs) ? handoff.relaunchTimeoutMs : 30000)
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const useOpen = attempt % 2 === 0
    let pid = null
    try {
      if (useOpen) {
        execFileSync('/usr/bin/open', ['-n', '-a', APP_PATH], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
        log(`attempt ${attempt}: open -n sent`)
      } else {
        const child = spawn(EXE_PATH, [], { detached: true, stdio: 'ignore', env: guiEnv() })
        child.unref()
        pid = child.pid ?? null
        log(`attempt ${attempt}: spawned ${EXE_PATH} pid=${pid}`)
      }
    } catch (error) {
      log(`attempt ${attempt}: launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await sleep(3500) // 启动窗口：被系统回收的实例会在这一窗口内死掉
    if (pid === null || !alive(pid)) pid = findNewMainPid(baseline)
    if (pid !== null && alive(pid)) {
      log(`attempt ${attempt}: pid ${pid} survived`)
      return pid
    }
    log(`attempt ${attempt}: no surviving new instance`)
    await sleep(1500)
  }
  log(`relaunch gave up after ${attempt} attempts`)
  return null
}

async function main() {
  log(`start pid=${process.pid} main=${handoff.mainPid} app=${APP_PATH} source=${handoff.source}`)
  const baseline = new Set(bundlePids().map((entry) => entry.pid))
  baseline.add(handoff.mainPid)
  log(`baseline pids: ${[...baseline].join(',')}`)
  await sleep(handoff.delayMs)

  let quitSent = false
  try {
    execFileSync('/usr/bin/osascript', ['-e', `tell application "${APP_NAME}" to quit`], { timeout: handoff.quitTimeoutMs, stdio: 'ignore' })
    quitSent = true
    log('quit requested via osascript')
  } catch (error) {
    log(`osascript quit failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 有任务在跑 / 有排程提醒时，宿主会弹原生「确认退出」框，远程点不到；
  // 等 dialogWaitMs 仍未退出就先 SIGTERM；SIGTERM 会被 Chromium 的优雅退出路径吞掉
  // （又回到同一个框），所以 SIGTERM 无效时再升级到 SIGKILL —— 这是唯一能让远程重启
  // 不被原生框卡死的方式。
  let exited = await waitUntil(() => !alive(handoff.mainPid), quitSent ? DIALOG_WAIT_MS : 0)
  if (!exited && handoff.allowSigtermFallback !== false) {
    log(`main still alive after quit request: likely native quit confirmation dialog; sending SIGTERM`)
    try {
      process.kill(handoff.mainPid, 'SIGTERM')
    } catch (error) {
      log(`SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    exited = await waitUntil(() => !alive(handoff.mainPid), SIGTERM_WAIT_MS)
  }
  if (!exited && handoff.allowSigkillFallback !== false) {
    log('SIGTERM ineffective while the quit confirmation is pending; sending SIGKILL')
    try {
      process.kill(handoff.mainPid, 'SIGKILL')
    } catch (error) {
      log(`SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    exited = await waitUntil(() => !alive(handoff.mainPid), SIGKILL_WAIT_MS)
  }
  if (!exited) abort('应用未退出（确认对话框无法远程处理，且 SIGTERM/SIGKILL 都无效）')
  log('main process exited')

  const pid = await relaunch(baseline)
  if (pid === null) abort('新实例未出现')
  log(`relaunched OK pid=${pid}`)
  notify('DSH 已重启')
  cleanup()
  process.exit(0)
}

main().catch((error) => {
  log(`unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanup()
  process.exit(1)
})
