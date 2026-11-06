/**
 * 重启编排：桌面检测 → 防重入 → 拉起 detached helper。
 *
 * 约束（2026-11-06 实测）：桌面版 host 是 Electron 主进程的子进程
 * （host ppid = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"），
 * 宿主拿不到 electron.app，因此不能用 app.relaunch()；本模块只负责交接，
 * 真正的 quit/重拉由 helper.mjs 在宿主死后完成：
 *   quit → （有任务在跑时宿主弹原生确认框，远程点不到）等 dialogWaitMs → SIGTERM
 *   → 等进程树清空 → 直接 spawn bundle 二进制（绕开 LaunchServices）。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh')
const LOG_DIR = path.join(HOME, 'logs')
const LOG_PATH = path.join(LOG_DIR, 'macos-restart.log')
const LOCK_PATH = path.join(HOME, 'macos-restart.lock')
const HELPER_PATH = new URL('./helper.mjs', import.meta.url).pathname
const DEFAULT_APP_PATH = '/Applications/DeepSeek Harness.app'

function psCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 4000 }).trim()
  } catch {
    return ''
  }
}

/** 当前宿主是否就是 macOS 桌面版（而不是 `dsh web` 的纯 Node 宿主）。 */
export function isDesktopHost() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return false
  const command = psCommand(process.ppid)
  return command.includes('DeepSeek Harness.app/Contents/MacOS/')
}

function lockActive() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim()
    const startedAt = Number(raw)
    if (!Number.isFinite(startedAt)) return false
    // 超过 3 分钟视为陈旧锁（helper 最坏总耗时约 75 秒）
    return Date.now() - startedAt < 3 * 60 * 1000
  } catch {
    return false
  }
}

function writeLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [host] ${line}\n`)
  } catch {
    // 日志失败不影响重启
  }
}

/**
 * 创建重启服务。
 * @param {object} config - `{ appPath?, delayMs?, dialogWaitMs?, quitTimeoutMs?, relaunchTimeoutMs?, allowSigtermFallback?, allowSigkillFallback? }`
 */
export function createRestart(config = {}) {
  const appPath = typeof config.appPath === 'string' && config.appPath.length > 0 ? config.appPath : DEFAULT_APP_PATH
  const handoffPath = path.join(HOME, 'macos-restart-handoff.json')

  return {
    /**
     * 请求重启（不等待完成）。
     * @param {'tool'|'button'} source
     * @param {{ dryRun?: boolean }} [options]
     */
    async request(source, options = {}) {
      if (!isDesktopHost()) {
        return { ok: false, error: { message: '本插件只支持 macOS 桌面版 DSH（当前宿主不是桌面应用的子进程）' } }
      }
      if (lockActive()) {
        return { ok: false, error: { message: '上一次重启还在进行中，请稍后再试' } }
      }
      const mainPid = process.ppid
      if (options.dryRun === true) {
        return { ok: true, dryRun: true, mainPid, appPath }
      }
      const handoff = {
        mainPid,
        appPath,
        source,
        logPath: LOG_PATH,
        lockPath: LOCK_PATH,
        delayMs: Number.isFinite(config.delayMs) ? config.delayMs : 1500,
        dialogWaitMs: Number.isFinite(config.dialogWaitMs) ? config.dialogWaitMs : 6000,
        quitTimeoutMs: Number.isFinite(config.quitTimeoutMs) ? config.quitTimeoutMs : 25000,
        relaunchTimeoutMs: Number.isFinite(config.relaunchTimeoutMs) ? config.relaunchTimeoutMs : 30000,
        allowSigtermFallback: config.allowSigtermFallback !== false,
        allowSigkillFallback: config.allowSigkillFallback !== false,
      }
      try {
        fs.mkdirSync(HOME, { recursive: true })
        fs.writeFileSync(LOCK_PATH, String(Date.now()))
        fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2))
      } catch (error) {
        return { ok: false, error: { message: `无法写入交接文件：${error instanceof Error ? error.message : String(error)}` } }
      }
      writeLog(`schedule restart source=${source} main=${mainPid}`)
      try {
        const child = spawn(process.execPath, [HELPER_PATH, handoffPath], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        child.unref()
      } catch (error) {
        try {
          fs.rmSync(LOCK_PATH, { force: true })
        } catch {
          // ignore
        }
        return { ok: false, error: { message: `无法启动重启助手：${error instanceof Error ? error.message : String(error)}` } }
      }
      return { ok: true, scheduled: true, mainPid }
    },
  }
}
