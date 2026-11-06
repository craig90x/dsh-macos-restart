# dsh-macos-restart

给 **macOS 桌面版** DeepSeek Harness 补一个原生重启入口。官方发布版没有重启命令（App 菜单里的「重启应用与 Host」只在 `!app.isPackaged` 的开发构建中注入），插件装好后能重启的标准流程只有 Cmd+Q 再手动打开。

本插件提供两处入口：

| 入口 | 说明 |
|---|---|
| 设置 → 通用 → 「重启 DSH」 | 一行按钮，点一下即可 |
| 工具 `restart_dsh` | 对 agent 说「重启 DSH」即可触发；仅响应用户明确要求 |

## 重启流程

```
宿主(host)                       helper（detached，活过宿主死亡）
   │ spawn ───────────────────────▶ 等 1.5s（让响应先到浏览器）
   │                                osascript quit
   │                                └ 6s 内没退（有任务时宿主弹原生确认框，远程点不到）
   │                                  → SIGTERM（会被 Chromium 转成优雅退出，又落回同一个框）
   │                                  → 5s 仍不退 → SIGKILL 主进程（远程可用性的最后手段）
   │                               等主进程退出 + 整棵 bundle 进程树消失
   │                               spawn / open -n 交替重试（跨过约 15s 系统回收窗口）
   │                               每次等 3.5s 确认新实例没被秒收 → 最多 30s
   │                               写日志 → 系统通知 → 删锁
```

日志：`~/.dsh/logs/macos-restart.log`（每行带阶段）；锁：`~/.dsh/macos-restart.lock`（3 分钟自动过期）。

## 安装

```bash
# 通过 DSH 插件管理器安装本地目录（或设置 → 插件 → 添加插件 → 本地目录）
plugin_manager install_bundle target=/path/to/dsh-macos-restart
```

从 GitHub 获取源码：

```bash
git clone https://github.com/craig90x/dsh-macos-restart.git
plugin_manager install_bundle target=/path/to/dsh-macos-restart
```

安装后**需要手动重启一次**（此时插件还没加载，鸡生蛋），之后重启入口就生效了。

## 配置（profile 的 cordis.patch.yml 或插件默认）

```yaml
- id: macos-restart
  name: dsh-macos-restart
  config:
    appPath: /Applications/DeepSeek Harness.app   # 应用路径（默认值同此）
    delayMs: 1500                                  # 交接前等待，让 HTTP 响应送达
    dialogWaitMs: 6000                             # 发出 quit 后等这么久，仍未退出即视为确认框
    quitTimeoutMs: 25000                           # osascript quit 的超时上限
    relaunchTimeoutMs: 30000                       # 重拉总时限（需跨过约 15s 的系统回收窗口）
    allowSigtermFallback: true                     # 是否允许 SIGTERM（通常无效，仅先试一下）
    allowSigkillFallback: true                     # 是否允许 SIGKILL 兜底（false 则只优雅退出，远程可能永久卡框）
```

## 修复记录

**v0.1.3 — 「SIGTERM 在确认框存在时也无效」**（2026-11-06 实测）
v0.1.2 的推论「宿主没有 SIGTERM 处理器，SIGTERM 会立即终止」是错的。实测 `source=tool` 重启（宿主有进行中任务 → 必弹确认框）：
`quit requested via osascript` → 6s 后主进程仍在 → `sending SIGTERM` → 再等 25s 主进程仍在 → `ABORT: 应用未退出（确认对话框无法远程处理，且 SIGTERM 无效）`。原因：Electron/Chromium 的 browser 进程自己捕获 SIGTERM 并转成优雅退出，于是又落回同一个被原生框卡住的 `before-quit`。**修复**：SIGTERM 只等 5s，仍未退出就升级 **SIGKILL** 主进程；重拉前若 bundle 进程树仍有残留也一并 SIGKILL。`allowSigkillFallback: false` 可关闭该升级（届时远程遇到确认框只能人工点）。
代价：SIGKILL 会截断当前进行中的回合（会话文件是增量写的，不会整份丢失）。

**v0.1.2 — 「远程点重启，卡在确认框」+「续跑时新实例秒退」**（2026-11-06 实测）
两个问题：

1. DSH 桌面主进程在 `before-quit` 里会调 `inspectQuit()`：只要宿主报告**有进行中任务或已武装的排程提醒**，就弹原生 `dialog.showMessageBox`「确认退出」框（默认按钮=退出）。远程没人点就永远卡住。官方唯一的跳过开关 `skipQuitConfirmation` 只在崩溃恢复与开发版菜单里设置，插件/外部进程都够不到；系统级 UI 自动化又被 TCC 拒绝（`osascript 不允许辅助访问`）。**修复**：发 quit 后等 `dialogWaitMs`（默认 6s）仍未退出，就对主进程发 `SIGTERM` —— 桌面 main 里没有任何 SIGTERM 处理器，会直接终止（不经过 `before-quit`），因此不会卡框；仍然不升级 SIGKILL。
2. 旧实例退出后的**约 15 秒内**，同 bundle 的新实例会被系统立刻回收：v0.1.1 的 `open -n` 连试 4 次、v0.1.2 实测直接 `spawn` 连试 3 次，日志都是 `died during startup`；跨过该窗口后两种方式都能成功（实测 DSH 直接 spawn、Calculator `open -n` 各成功一次）。**修复**：重拉改为 `spawn` 与 `open -n` 交替重试，每次等 3.5s 启动窗口确认存活，直到 `relaunchTimeoutMs`（默认 30s）用完。

代价：SIGTERM 不是优雅退出，进行中的回合会被截断（会话文件本身是增量写的，不会整份丢失）；这是远程可用的必要取舍。

**v0.1.1 — 「退出了但不重启」**（2026-11-06 实测事故）
v0.1.0 用 `pgrep -f "<appPath>/Contents/MacOS/"` 判断是否已重启，而 **helper 自己的命令行就包含这个路径**，于是发出 `open` 后 41ms 内就误判成功、删锁退出；同时 `open -a` 在主进程退出后 0.6s 就调用，此时 launchservicesd 仍认为应用在运行，`open` 退化成"激活已有实例"，实际什么都没发生。修复：

1. 判定改为解析 `ps` 输出的「pid/ppid/command」，只认 **ppid=1、命令行是可执行体本身、且不在重启前 baseline 里的新 pid**；
2. 重新拉起前等**整棵 bundle 进程树**（含 GPU/Renderer/Helper 与宿主 node 子进程）消失，最多 10s；
3. 用 `open -n -a`（强制新实例），8s 内没等到新 pid 就重试，最多 4 轮；
4. 新 pid 出现后再观察 2.5s 确认它站住，避免"启动即退出"的假成功；
5. 全部失败时兜底直接 `spawn` bundle 内二进制（清掉 `ELECTRON_RUN_AS_NODE`，否则会被当成 node 跑）。

该路径已用 Calculator.app 做过完整端到端验证（quit → 等进程树清空 → relaunch → 新 pid 站住）。

## 已知限制

- 只支持 macOS 桌面版；`dsh web`（纯 Node 宿主）会明确拒绝。
- 重启会中断进行中的任务。有任务在跑时必定出现原生「确认退出」框，helper 6 秒后先 SIGTERM、再 5 秒仍不退就 SIGKILL，因此远程也能完成重启；`allowSigkillFallback: false` 时会退回「放弃并通知失败」（远程只能人工点框）。
- 每次重启 host 端口会变（例如 51489 → 59523）。本地窗口由新实例自带，远端访问靠代理自动跟随。
- 若 macOS TCC 拒绝 Apple Events（`osascript quit failed`），helper 会直接跳到 SIGTERM/SIGKILL 兜底。

## 回滚

1. `plugin_manager remove_bundle target=dsh-macos-restart`（或设置 → 插件里卸载）；
2. 若手工改过 `~/.dsh/profiles/desktop/cordis.patch.yml`，还原备份；
3. 重启一次。
