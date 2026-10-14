/**
 * ext-nowplaying.js — 「扩展」页签**四号模块**（听歌）的扩展岛 + 侧栏壁纸页共用节。
 *
 * ══ 它是什么 ══════════════════════════════════════════════════════════════════
 * 一个**模块描述符**（形状 `{ id, title, desc?, render? }`，契约写在 src/panel-tabs.js 的
 * `extensionModules()` 上方）+ 一个**共用节渲染器** `renderNowPlayingSection(ctx)`。
 * 照抄 `renderAudioTab` 的先例（一份渲染器、多处调用点）：设置页画在「扩展」页签的岛里，
 * 侧栏壁纸页画独立的一节（`src/quick-panel.js` 挨着声音那节），两处同一状态、同一处理器。
 * 数据腿在 `src/now-playing-store.js`（轮询 / 引用计数启停 / 失败退避），宿主端零改动：
 * 读的是既有路由 `GET /now-playing`，控制走既有 `POST /media-control`（动作白名单五个）。
 *
 * 契约：
 *   需要的外界：`ctx`（设置页档由 `src/client.js` 的 `extensionCtx()` 组装；侧栏档由
 *     `sidebarRenderCtx({ sel, onMediaControl })` 组装）——
 *     `sel`（读 `sel.nowPlaying` 这个瞬态快照，真源见该 store 文件头）
 *     + 两枚具名处理器 `onNowPlayingEnabled` / `onMediaControl`。
 *   对外提供：`NOWPLAYING_EXTENSION_MODULE`（注册表项）+ `renderNowPlayingIsland(ctx)` +
 *     `renderNowPlayingSection(ctx)`。
 *
 * 不变量：
 *   · **模块不得自己写设置 / 发通知 / 持有状态**（panel-tabs 的注册表契约）：本文件里
 *     没有 `setSetting`、没有 `emit(`、没有 `selection` 直呼，一个动作一个 `on*` 处理器。
 *   · **只从一个参数取外界**：两个渲染器都是 `(ctx)`，函数体第一行解构。
 *   · **侧栏档没有媒体时整节返回 null**（用户口径：「整块藏起来」）—— 设置页的岛不同：
 *     开关开着时画一句空态（关了开关看不见它、开着又什么都不显示，用户会以为功能坏了）。
 *   · **回显即生效**：进度条 / 歌词当前行只按 `sel.nowPlaying` 现算，本文件不缓存任何
 *     跨渲染的派生值（拍子在 store 那一侧，渲染器是无状态的纯读数）。
 *   · 关掉总开关时**只画总开关 + 一句说明**（与别的模块同口径）。
 */

/** 秒 → `m:ss`（进度读数用；纯数字串，不进词表）。 */
function npTime(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/**
 * 歌词当前行的文本（"" = 没有可显示的行）。
 * `lyrics` 是宿主换算好的 `[[秒, 文本], …]`（lib/media/supervisor.js 的 lyricsToTuples），
 * 按时间序取"已到点的最后一行"——渲染页自己按 position 算当前行是上游口径，这里照做。
 */
function npLyricLine(lyrics, position) {
  if (!Array.isArray(lyrics) || !lyrics.length) return "";
  const pos = Number(position) || 0;
  let text = "";
  for (let i = 0; i < lyrics.length; i += 1) {
    const line = lyrics[i];
    if (!Array.isArray(line)) continue;
    if (Number(line[0]) <= pos) text = String(line[1] == null ? "" : line[1]);
  }
  return text;
}

/** 封面 / 曲目信息 / 进度 / 歌词当前行 —— 岛与侧栏共用这一整块排布。
 *  `onMediaControl` 为空（没接线）时三个按钮不画：画了也点不动，那是假控件。 */
function npMediaBlock(m, onMediaControl) {
  const dur = Number(m.duration) || 0;
  const pos = Math.max(0, Number(m.position) || 0);
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const lyric = npLyricLine(m.lyrics, pos);
  const byline = [m.artist, m.album].filter(Boolean).join(" · ");
  const btn = (action, glyph, label) => React.createElement("button", {
    className: "we-picker__btn we-np__btn",
    type: "button",
    key: "np-" + action,
    title: label,
    "aria-label": label,
    onClick: () => onMediaControl(action),
  }, glyph);
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "we-np" },
      m.thumbnail
        ? React.createElement("img", {
            className: "we-np__art", src: m.thumbnail, alt: "", draggable: false,
          })
        : React.createElement("span", { className: "we-np__art we-np__art--empty", "aria-hidden": "true" }),
      React.createElement("div", { className: "we-np__body" },
        React.createElement("span", { className: "we-np__title" }, m.title || ""),
        byline ? React.createElement("span", { className: "we-np__byline" }, byline) : null,
        React.createElement("div", { className: "we-np__bar", "aria-hidden": "true" },
          React.createElement("span", { className: "we-np__fill", style: { width: pct.toFixed(1) + "%" } }),
        ),
        React.createElement("span", { className: "we-np__time" },
          dur > 0 ? npTime(pos) + " / " + npTime(dur) : npTime(pos)),
      ),
    ),
    lyric ? React.createElement("span", { className: "we-picker__hint we-np__lyric" }, lyric) : null,
    onMediaControl
      ? React.createElement("div", { className: "we-np__ctl" },
          btn("skipPrevious", "⏮", weT("上一首")),
          btn("playPause", m.playing ? "⏸" : "▶", m.playing ? weT("暂停") : weT("播放", null, "play")),
          btn("skipNext", "⏭", weT("下一首")),
        )
      : null,
  );
}

/**
 * 共用节：有媒体就画封面 + 曲目 + 进度 + 歌词 + 三个按钮；没有媒体时按 `empty` 决定。
 * @param {object} ctx 见文件头契约
 * @param {boolean} empty `true` = 无媒体时画一句空态；`false` = 返回 null（侧栏档用）
 */
function npSection(ctx, empty) {
  const { sel, onMediaControl } = ctx;
  const m = sel && sel.nowPlaying;
  if (!m || m.hasMedia !== true) {
    return empty
      ? React.createElement("span", { className: "we-picker__hint" },
          weT("没有正在播放的媒体"))
      : null;
  }
  return npMediaBlock(m, onMediaControl);
}

/**
 * 侧栏壁纸页那一节（**没有媒体时返回 null** —— 用户口径「整块藏起来」）。
 * 只读 `ctx.sel` / `ctx.onMediaControl`，与设置页那份同一个渲染器。
 * @param {{sel:object, onMediaControl?:Function}} ctx
 */
function renderNowPlayingSection(ctx) {
  const { sel, onMediaControl } = ctx;
  // 总开关关着 ⇒ 这一节整个不存在（侧栏不画开关，开关的真源是设置页那一份）。
  if (!sel || sel.nowPlayingEnabled !== true) return null;
  return npSection({ sel, onMediaControl }, false);
}

/**
 * 扩展岛：总开关 → 说明 → 有媒体时那一块（无媒体时一句空态）。
 * @param {{sel:object}} ctx 见文件头契约
 */
function renderNowPlayingIsland(ctx) {
  const { sel, onNowPlayingEnabled, onMediaControl } = ctx;
  const on = sel.nowPlayingEnabled === true;
  return React.createElement(React.Fragment, null,
    switchRow(weT("启用听歌"), on, onNowPlayingEnabled, { key: "np-on" }),
    React.createElement("span", { className: "we-picker__hint", key: "np-what" },
      weT("显示系统正在播放的媒体（歌名 / 歌手 / 专辑 / 进度 / 歌词）并提供上一首、播放暂停、下一首三个按钮；数据来自 Windows 系统媒体会话，不依赖任何播放器插件")),
    on ? npSection(ctx, true) : null,
  );
}

/** 「扩展」页签的四号模块（注册表项；`id` 是 React key，改它会让面板重挂一次）。
 *  `title` / `desc` 与另外三个模块同一条理由写成 getter（渲染时才取译文，见 panel-tabs 的契约）。 */
const NOWPLAYING_EXTENSION_MODULE = {
  id: 'nowplaying',
  // 模块级重置的分组名（issue #192）：键集住在 lib/settings-schema.js 的 RESET_MODULES。
  resetGroup: 'nowPlaying',
  get title() { return weT("听歌"); },
  get desc() { return weT("在面板上显示系统正在播放的媒体，并直接控制上一首 / 播放暂停 / 下一首（默认关）"); },
  render: renderNowPlayingIsland,
};

export { NOWPLAYING_EXTENSION_MODULE, renderNowPlayingIsland, renderNowPlayingSection };
