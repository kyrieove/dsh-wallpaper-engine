/**
 * now-playing-store.js — 「听歌」扩展模块的**轮询通道**（「扩展」页签四号模块的数据腿）。
 *
 * ══ 它是什么 ══════════════════════════════════════════════════════════════════
 * 一条住在 `src/client.js` 正文与 `src/ext-nowplaying.js` 之间的**模块级**通道：
 * 按拍 `GET /now-playing`（宿主既有路由，链路是 media-bridge → Windows GSMTC，见
 * lib/routes/now-playing.js），把成功回的快照写进 `selection` 的那个瞬态字段
 * （`nowPlaying`），渲染器只经 `sel.*` 读。
 * 为什么轮询不能长在渲染器里：扩展模块的契约是**不得持有状态、不得自己发通知**
 * （见 src/panel-tabs.js 注册表契约与 src/ext-avatar.js 文件头的不变量）。所以拍子与
 * `emit()` 住在本文件，与 `src/system-fonts.js`（宿主扫描通道）**同一形态**、同一条登记表纪律。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   selection          ← 共享 store（本文件只写自己那两个瞬态字段，**经 `setTransient` 入口**
 *                        而不是裸直写 —— 本仓的写入口纪律，同 src/system-fonts.js）
 *   setTransient       ← src/client.js（瞬态字段的唯一写入口，不落盘）
 *   apiJson            ← src/api-client.js（宿主 API 唯一出入口；BASE 只在调用期读）
 *   emit               ← 单向重渲染
 * 提供：
 *   acquireNowPlaying()   引用 +1；0→1 时起拍并**立即拉一次**（面板打开不该先空一拍）
 *   releaseNowPlaying()   引用 -1；→0 时停拍并清空字段（没人在看 = 一个请求都不发）
 *   pollNowPlayingOnce()  拉一次，返回 Promise<boolean>（反向控制后立刻刷新用）
 *
 * 不变量：
 *   · **只在有面板挂着时运转**：两个消费者（设置页「扩展」页签的岛 + 侧栏壁纸页那节）各自
 *     挂载 acquire / 卸载 release，引用计数是模块级的。**总开关 `nowPlayingEnabled` 关着时
 *     两边都不 acquire** ⇒ 零网络；这条闸在调用点（client.js / quick-panel.js），不在这里。
 *   · **失败退避、成功恢复**：连续 {@link NOW_PLAYING_FAIL_SLOW_AT} 次失败转慢拍；任何一次
 *     成功复位计数与拍速。为什么慢拍还要存在：宿主路由恒在，但 media-bridge 是**空闲自动停**
 *     的子进程，第一拍可能撞上超时（lib/media/supervisor.js 的 touch() 会唤醒它），所以
 *     "失败"不判死刑、也不许在 1s 快拍上反复敲一扇没热的门。
 *   · **失败不清空已有快照**：网络抖一下不该让屏上那首歌闪回空态（与 system-fonts 的
 *     "失败不清空清单"同一条理由）；宿主说"没有在播"（`media: null`）是**正常状态**，照写。
 *   · **字段是瞬态**：不进 schema 的持久化白名单（`serializeSettings` 按白名单过滤，
 *     写盘轮不上它们）、不进 localStorage。
 *   · **不做二次加工**：`position` 宿主已按 rate 外推、`lyrics` 已是 `[[秒, 文本], …]`
 *     元组（supervisor.nowPlaying 的口径），当前行由渲染器现算，本文件原样存。
 *   · 本文件必须浏览器安全（无 import / Node API），且**不得有顶层可执行语句**读外层 const
 *     （内联位置早于 client.js 正文 —— 照 src/system-fonts.js 的同一条纪律）。
 */

/** 快拍（ms）：宿主侧 media-bridge 本身就是 1s 的拍，面板拉更细没有更新的信息。 */
const NOW_PLAYING_FAST_MS = 1000;
/** 连续失败后的慢拍（ms）：读不到就退到 10s，门一开（起桥/恢复）最坏 10s 后追平。 */
const NOW_PLAYING_SLOW_MS = 10000;
/** 转入慢拍所需的连续失败数：第 1、2 次失败可能就是桥在唤醒，不该立刻惩罚成慢拍。 */
const NOW_PLAYING_FAIL_SLOW_AT = 3;

let nowPlayingRefs = 0;      // 挂着的面板数（0 = 停拍，本模块对网络零责任）
let nowPlayingTimer = 0;     // 当前 setInterval 的 id（0 = 没在跑）
let nowPlayingSlow = false;  // 当前拍是不是慢拍（成功时要复位）
let nowPlayingFails = 0;     // 连续失败计数（任何成功清零）
let nowPlayingBusy = false;  // 在途守卫：一拍没回就不叠第二拍（慢网下 interval 不等人）

/** 把在途 timer 按当前档位重建（快↔慢切换的唯一出口；没在跑时是空操作）。 */
function restartNowPlayingTimer() {
  if (!nowPlayingTimer) return;
  clearInterval(nowPlayingTimer);
  nowPlayingTimer = setInterval(nowPlayingTick, nowPlayingSlow ? NOW_PLAYING_SLOW_MS : NOW_PLAYING_FAST_MS);
}

/** 一次失败的记账：计数 +1，到阈值转慢拍（同档重复切是空操作，restart 自己幂等）。 */
function failNowPlayingPoll() {
  nowPlayingFails += 1;
  if (nowPlayingFails >= NOW_PLAYING_FAIL_SLOW_AT && !nowPlayingSlow) {
    nowPlayingSlow = true;
    restartNowPlayingTimer();
  }
}

/**
 * 拉一次并落字段。不抛：api-client 已把网络失败折成 `{ok:false}`，这里的返回值只说
 * "这一拍成功了吗"（供 pollNowPlayingOnce 的调用方决定要不要重试一次）。
 * `media` 为 null 是**成功**（宿主确认没有在播），与"没问到"（失败）严格分开。
 */
function nowPlayingTick() {
  if (nowPlayingBusy) return Promise.resolve(false);
  nowPlayingBusy = true;
  return apiJson("/now-playing").then((res) => {
    nowPlayingBusy = false;
    const d = res && res.data;
    if (!res.ok || !d || d.ok !== true) {
      failNowPlayingPoll();
      return false;
    }
    nowPlayingFails = 0;
    if (nowPlayingSlow) {
      nowPlayingSlow = false;
      restartNowPlayingTimer();
    }
    setTransient("nowPlaying", d.media || null);
    emit();
    return true;
  }).catch(() => {
    // 预料外的抛（替身/环境异常）：与网络失败同一记账，绝不让它打断 interval。
    nowPlayingBusy = false;
    failNowPlayingPoll();
    return false;
  });
}

/** 消费者挂载时调。0→1 才起网络；之后每个 acquire 只是记一笔。 */
function acquireNowPlaying() {
  nowPlayingRefs += 1;
  if (nowPlayingRefs === 1) {
    nowPlayingFails = 0;
    nowPlayingSlow = false;
    nowPlayingTick();
    nowPlayingTimer = setInterval(nowPlayingTick, NOW_PLAYING_FAST_MS);
  }
}

/** 消费者卸载时调。→0 停拍并清空快照：下次打开必须先拿到真数据，不拿旧帧冒充"在播"。 */
function releaseNowPlaying() {
  nowPlayingRefs = Math.max(0, nowPlayingRefs - 1);
  if (nowPlayingRefs > 0) return;
  if (nowPlayingTimer) {
    clearInterval(nowPlayingTimer);
    nowPlayingTimer = 0;
  }
  setTransient("nowPlaying", null);
}

/** 消费者侧的显式刷新腿（反向控制后立刻拉一次，见文件头契约）。 */
function pollNowPlayingOnce() { return nowPlayingTick(); }

export { acquireNowPlaying, releaseNowPlaying, pollNowPlayingOnce };
