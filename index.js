/**
 * dsh-macos-restart —— host 半身。
 *
 * 打包版 DSH 没有重启入口（官方菜单项只在开发构建里注入）。本插件补两处：
 *   1. 面向模型的工具 `restart_dsh`；
 *   2. `POST /api/dsh-macos-restart/restart`，供设置页按钮调用（body 可带
 *      `{ "dryRun": true }` 只做可重启性检查、不真的退出）。
 *
 * 真正动手的是 restart.js 拉起的 detached helper（helper.mjs）——宿主进程
 * 拿不到 electron.app，只能走「外部接管」：优雅 quit → 等主进程消失 →
 * `open -a` 重新拉起。
 */
import { createRestart } from './restart.js'

export const name = 'macos-restart'
export const inject = ['tools']

export function apply(ctx, config) {
  const restart = createRestart(config ?? {})
  const disposers = []

  try {
    disposers.push(ctx.tools.register({
      name: 'restart_dsh',
      description: '重启 DeepSeek Harness 桌面应用：优雅退出后自动重新打开，约 20–30 秒不可用（期间当前会话会重连）。若已有任务在跑，macOS 会弹原生「确认退出」框，helper 约 6 秒后自动强制退出，无需人工点击。仅在用户明确要求重启 DSH 时调用，不要自行决定重启。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value ?? {}
          if (v.ok === true) {
            return [{ type: 'text', text: `已排程重启：DSH 将在约 2 秒后退出并重新打开（主进程 pid ${v.mainPid}）。若有任务在跑会弹出「确认退出」框，约 6 秒后自动强制退出，不需要人工点击。` }]
          }
          const message = v.error && typeof v.error.message === 'string' ? v.error.message : '未知原因'
          return [{ type: 'text', text: `重启未执行：${message}` }]
        },
      },
      async execute() {
        return await restart.request('tool')
      },
    }))

    ctx.inject?.(['connection'], (host) => {
      const remove = host.connection?.fetch?.register({
        path: '/api/dsh-macos-restart/restart',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = null
          try {
            body = await request.json()
          } catch {
            body = null
          }
          const result = await restart.request('button', { dryRun: body?.dryRun === true })
          return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        },
      })
      if (typeof remove === 'function') disposers.push(remove)
    })

    ctx.on?.('dispose', () => {
      for (const fn of disposers.splice(0).reverse()) {
        try {
          fn?.()
        } catch {
          // dispose 阶段忽略单个清理失败
        }
      }
    })
  } catch (error) {
    for (const fn of disposers.splice(0).reverse()) {
      try {
        fn?.()
      } catch {
        // ignore
      }
    }
    throw error
  }
}
