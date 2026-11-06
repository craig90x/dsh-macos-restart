/**
 * dsh-macos-restart —— client 半身（设置 → 通用 的一行）。
 *
 * 手工按 DSH 客户端的 module-loader 协议编写（与 dsh-setting-restart 同格式）：
 * window.__ModuleLoader__.load({ id, factory })，factory 内用 require() 取
 * react / react/jsx-runtime。点击后直接同源 POST /api/dsh-macos-restart/restart，
 * 宿主收到后排程重启；页面在 connection/reset 后确认重连成功。
 */
window.__ModuleLoader__.load({
  id: "dsh-macos-restart",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // #region styles
    const css = ".dmr_row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.dmr_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.dmr_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.dmr_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.dmr_button{background:var(--dsw-alias-bg-module-platform);height:36px;flex:none;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-family:inherit;font-size:14px;line-height:22px;display:inline-flex}.dmr_button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dmr_button:disabled{cursor:default;opacity:.5}.dmr_connected{color:var(--dsw-alias-state-success-primary)}.dmr_failure{max-width:220px;color:var(--dsw-alias-state-error-primary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}";
    const tagId = "dsh-macos-restart/RestartRow.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-macos-restart";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    const styles = { row: "dmr_row", rowText: "dmr_rowText", title: "dmr_title", desc: "dmr_desc", button: "dmr_button", connected: "dmr_connected", failure: "dmr_failure" };
    // #endregion

    // #region locales
    const zh = {
      "row.title": "重启 DSH",
      "row.description": "优雅退出桌面应用并自动重新打开；重启期间本页面会自动重新连接（约 20–30 秒）。",
      "row.button": "重启",
      "row.restarting": "正在重启…",
      "row.reconnecting": "重启完成，正在重新连接…",
      "row.connected": "连接成功",
      "row.failed": "重启失败"
    };
    const en = {
      "row.title": "Restart DSH",
      "row.description": "Quit the desktop app gracefully and reopen it. This page reconnects automatically (about 20–30 seconds).",
      "row.button": "Restart",
      "row.restarting": "Restarting…",
      "row.reconnecting": "Restarted, reconnecting…",
      "row.connected": "Connected",
      "row.failed": "Restart failed"
    };
    // #endregion

    const NS = "macos-restart";
    const inject = ["slots", "locale", "connection"];
    const RESTARTING_HOLD_MS = 3000;
    const CONNECTED_HOLD_MS = 4000;

    /**
     * 同源调用重启端点。
     * @param {{ dryRun?: boolean }} payload
     * @returns {Promise<{ ok: true, value: any } | { ok: false, error: { message: string } }>}
     */
    async function callRestart(payload) {
      try {
        const response = await fetch("/api/dsh-macos-restart/restart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {})
        });
        const value = await response.json().catch(() => null);
        if (!response.ok) {
          return { ok: false, error: { message: (value && value.error && value.error.message) || "HTTP " + response.status } };
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    }

    function RestartRow({ restart, onReconnect, t }) {
      const [phase, setPhaseState] = react.useState("idle");
      const [failure, setFailure] = react.useState(null);
      const phaseRef = react.useRef("idle");
      const timers = react.useRef([]);
      const setPhase = (next) => {
        phaseRef.current = next;
        setPhaseState(next);
      };
      const later = (fn, ms) => {
        timers.current.push(setTimeout(fn, ms));
      };
      react.useEffect(() => () => {
        for (const timer of timers.current) clearTimeout(timer);
      }, []);
      react.useEffect(() => onReconnect(() => {
        if (phaseRef.current !== "restarting" && phaseRef.current !== "reconnecting") return;
        setPhase("connected");
        later(() => setPhase("idle"), CONNECTED_HOLD_MS);
      }), [onReconnect]);
      const onClick = () => {
        if (phaseRef.current !== "idle") return;
        setPhase("restarting");
        setFailure(null);
        restart().then((response) => {
          if (response.ok && response.value && response.value.ok === true) {
            later(() => setPhase("reconnecting"), RESTARTING_HOLD_MS);
            return;
          }
          const message = response.ok ? response.value && response.value.error && response.value.error.message : response.error && response.error.message;
          setPhase("idle");
          setFailure(message && message.length > 0 ? message : t("row.failed"));
        }, (error) => {
          setPhase("idle");
          setFailure(error instanceof Error ? error.message : t("row.failed"));
        });
      };
      const busy = phase === "restarting" || phase === "reconnecting";
      const label = phase === "connected" ? t("row.connected") : phase === "reconnecting" ? t("row.reconnecting") : phase === "restarting" ? t("row.restarting") : t("row.button");
      return (0, react_jsx_runtime.jsxs)("div", {
        className: styles.row,
        children: [
          (0, react_jsx_runtime.jsxs)("div", {
            className: styles.rowText,
            children: [
              (0, react_jsx_runtime.jsx)("div", { className: styles.title, children: t("row.title") }),
              (0, react_jsx_runtime.jsx)("div", { className: styles.desc, children: t("row.description") })
            ]
          }),
          (0, react_jsx_runtime.jsx)("button", {
            type: "button",
            className: phase === "connected" ? styles.button + " " + styles.connected : styles.button,
            disabled: busy,
            onClick: onClick,
            children: label
          }),
          failure === null ? null : (0, react_jsx_runtime.jsx)("span", { className: styles.failure, role: "status", children: failure })
        ]
      });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "macos-restart: dictionaries");
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "macos-restart",
        order: Number.MAX_SAFE_INTEGER,
        locale: NS,
        inject: () => ({
          restart: (signal) => callRestart({}),
          onReconnect: (listener) => ctx.on("connection/reset", listener)
        })
      }, RestartRow));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
