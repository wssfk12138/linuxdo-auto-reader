// ==UserScript==
// @name         LinuxDo Auto Read
// @namespace    https://github.com/wssfk12138/linuxdo-auto-reader
// @version      2.3.6
// @description  自动阅读 linux.do 帖子（完整阅读 · 自定义阅读速度 · 每贴 15~30 秒 · 多标签页独立启停 · 低速限流 · 防卡死 · 帖/楼层计数 · 自动点赞）
// @author       liuweiqing
// @match        https://meta.discourse.org/*
// @match        https://linux.do/*
// @match        https://meta.appinn.net/*
// @match        https://community.openai.com/*
// @match        https://idcflare.com/*
// @exclude      https://linux.do/a/9611/0
// @grant        none
// @noframes
// @run-at       document-idle
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// ==/UserScript==

// ---------------------------------------------------------------------------
// 2.0.0 相比 1.4.6/1.4.7 的主要改动
//   a) 修掉「卡住」：不再用 setInterval 反复打断滚动；改用单一定时器链。
//   b) 卡死自愈：连续几次没有滚动进展就先推到底部触发懒加载，
//      仍无进展且已读够时长就判定本贴读完，直接进入下一贴，不会原地空转。
//   c) 限流：所有请求之间、跳转之间都有随机间隔和硬性最小间隔；
//      列表用 /latest.json 且最多抓 2 页；遇到 429/错误指数退避。
//   d) 列表用 Discourse 内建 routeTo 做单页跳转，失败自动回退整页跳转。
//   e) 每日阅读上限、夜间静默（默认关闭）、速度档位可在「设置」里调。
//   f) 自动点赞默认关闭（原版未设置时会默认开启，这里已修正）。
//   g) 左下角实时显示：已阅读总帖数 / 今日帖数 / 当前状态。
//
// 2.1.0 改动
//   h) 每篇帖子只读 15~30 秒（设置里可改），到点立刻换下一篇，不再把整贴翻到底；
//      两篇之间固定休息 5 秒。
//   i) 自动点赞改成按楼层点赞数判定：只给「点赞数 > 30（设置里可改）」并且自己没赞过的
//      楼层点赞。点击目标是内层真实 button（旧版点的是外层 div，经常不生效），
//      每批最多 3 个、间隔 4~9 秒随机（保守档 9~20 秒），24 小时内最多 50 次。
//
// 2.2.0 改动
//   j) 多标签页各自独立控制：每个标签页有自己的一份「开始/停止阅读」和「自动点赞」开关，
//      在 A 标签页点停止只停 A，不会影响 B。左下方会显示本页标签号和其它正在运行的标签页数量。
//      阅读数 / 今日数 / 点赞数、帖子队列、点赞额度仍然全局共享：既不重复计算，
//      也不会让请求量随标签页数量翻倍（两次跳转之间的最小间隔同样是全局的）。
//   k) 新开的标签页默认是「停止」，需要自己点开始；可在「设置」里打开「新标签页自动开始阅读」。
//   l) 左下角计数器新增「累计楼层」：每篇帖子读完时统计本次加载出的楼层并去重累计，
//      同一层重复出现只算一次，所以这个数字只增不减，代表历史上读过的楼层总数。
//   m) 左下角控制区按「柔和工具风」重做配色与状态：深青主按钮、浅色底卡片，
//      悬停/按下/键盘聚焦都有反馈，文字照旧负责表达状态（颜色只是辅助）。
//
// 2.2.1 改动
//   n) 修掉「刷新页面后又变回已停止」：标签页身份只认 sessionStorage 里记着的 id，
//      刷新后沿用同一个 id，阅读状态接着跑；判断「是不是复制出来的标签页」改成两个页面
//      之间互相应答的探测（复制出来的标签页照旧换新 id、按新标签页处理）。
//
// 2.3.2 改动
//   r) 达到 24 小时点赞额度后保留用户的「自动点赞：开」意图，暂停点赞并显示原因，额度恢复后可继续。

// 2.3.1 改动
//   q) 自动点赞按钮只显示开关状态，阈值保留在设置项中；按钮组改为紧凑同排布局。
//
// 2.3.0 改动
//   o) 新增「快速（标准 2×）」阅读节奏：滚动间隔为标准档的一半，作为可选的最高速度。
//   p) 控制区改为悬浮摘要卡片：外部只保留阅读数据与状态，点击卡片才展开设置项。
//
// 2.3.4 改动
//   s) 可调的过去 24 小时点赞上限，默认 50 次；运行中恢复额度，每次扫描前读取共享计数。
//
// 2.3.5 UI 改动
//   t) 摘要卡片可从外部区域拖动，位置会记住；普通点击仍然展开/收起设置。
//
// 注意：linux.do 服务条款明确禁止使用插件/脚本自动访问论坛，
//       使用本脚本存在账号被风控或封禁的风险，请自行评估并保持低速。
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  // 只运行在最外层窗口，避免 iframe 里重复执行
  if (window.top !== window.self) return;

  // ============================================================
  // 1. 常量
  // ============================================================
  var BASE_URLS = [
    "https://linux.do",
    "https://meta.discourse.org",
    "https://meta.appinn.net",
    "https://community.openai.com",
    "https://idcflare.com/",
  ];
  var BASE_URL = null;
  for (var bi = 0; bi < BASE_URLS.length; bi++) {
    if (window.location.href.indexOf(BASE_URLS[bi]) === 0) { BASE_URL = BASE_URLS[bi]; break; }
  }
  if (!BASE_URL) BASE_URL = BASE_URLS[0];

  var COMMENT_LIMIT = 1000;    // 只阅读评论数小于该值的帖子
  var TOPIC_LIST_LIMIT = 60;   // 每轮最多准备多少篇候选帖
  var LIKE_PER_PASS = 3;       // 单轮扫描最多点赞几个楼层（铺开，避免短时间连点）

  var K = {
    read: "read",
    like: "autoLikeEnabled",
    topicList: "topicList",
    readIds: "readTopicIds",
    config: "autoReadConfig",
    stats: "autoReadStats",
    listCache: "autoReadListCache",
    lastNav: "autoReadLastNav",
    firstRun: "isFirstRun",
    clickCounter: "clickCounter",
    clickStamp: "clickCounterTimestamp",
    likeDefault210: "autoLikeDefault210",
    tabs: "autoReadTabs",
    floorIds: "autoReadFloorIds",
    uiPosition: "autoReadUiPosition",
  };

  // 两档节奏。safe 更慢、更像人工；normal 是默认档。
  var TIMING = {
    normal: {
      minStepPx: 12, maxStepPx: 26,
      minStepMs: 100, maxStepMs: 220,
      longPauseChance: 0.04, longPauseMin: 1500, longPauseMax: 5000,
      checkMin: 1500, checkMax: 3000,
      topicRestMin: 5000, topicRestMax: 5000,
      pageGapMin: 5000, pageGapMax: 12000,
      actionGapMs: 20000,
      listRefreshMs: 600000,
      maxPages: 2,
      stallLimit: 3, stallTimeoutMs: 45000,
      notReadyMs: 60000,
      backoff: [15000, 60000, 300000],
      likeGapMin: 4000, likeGapMax: 9000,
    },
    safe: {
      minStepPx: 8, maxStepPx: 18,
      minStepMs: 180, maxStepMs: 380,
      longPauseChance: 0.06, longPauseMin: 3000, longPauseMax: 9000,
      checkMin: 2500, checkMax: 5000,
      topicRestMin: 5000, topicRestMax: 5000,
      pageGapMin: 10000, pageGapMax: 20000,
      actionGapMs: 45000,
      listRefreshMs: 900000,
      maxPages: 1,
      stallLimit: 3, stallTimeoutMs: 60000,
      notReadyMs: 90000,
      backoff: [30000, 120000, 600000],
      likeGapMin: 9000, likeGapMax: 20000,
    },
    // 最高速度固定为标准档滚动节奏的 2 倍：步长不变，滚动间隔减半。
    fast: {
      minStepPx: 12, maxStepPx: 26,
      minStepMs: 50, maxStepMs: 110,
      longPauseChance: 0.04, longPauseMin: 750, longPauseMax: 2500,
      checkMin: 750, checkMax: 1500,
      topicRestMin: 5000, topicRestMax: 5000,
      pageGapMin: 5000, pageGapMax: 12000,
      actionGapMs: 20000,
      listRefreshMs: 600000,
      maxPages: 2,
      stallLimit: 3, stallTimeoutMs: 45000,
      notReadyMs: 60000,
      backoff: [15000, 60000, 300000],
      likeGapMin: 4000, likeGapMax: 9000,
    },
    // 极速为标准档 3×：保持步长与保护逻辑，缩短滚动和检查间隔。
    ultra: {
      minStepPx: 12, maxStepPx: 26,
      minStepMs: 33, maxStepMs: 73,
      longPauseChance: 0.03, longPauseMin: 500, longPauseMax: 1667,
      checkMin: 500, checkMax: 1000,
      topicRestMin: 5000, topicRestMax: 5000,
      pageGapMin: 5000, pageGapMax: 12000,
      actionGapMs: 20000,
      listRefreshMs: 600000,
      maxPages: 2,
      stallLimit: 3, stallTimeoutMs: 45000,
      notReadyMs: 60000,
      backoff: [15000, 60000, 300000],
      likeGapMin: 4000, likeGapMax: 9000,
    },
  };

  var DEFAULT_CONFIG = {
    speed: "normal",
    readingMode: "timed",
    dailyCap: 150,
    nightSilence: false,
    minDwellSec: 15,      // 每篇帖子至少读多久
    maxDwellSec: 30,      // 每篇帖子最长停留秒数（下限由 minDwellSec 决定）
    likeMinCount: 30,     // 只给点赞数超过该值的楼层点赞
    dailyLikeCap: 50,     // 过去 24 小时最多点赞次数，0 为暂停
    autoStart: false,     // 新开的标签页是否自动开始阅读（默认停下，自己点开始）
  };

  // 界面文案
  var TXT = {
    start: "开始阅读",
    stop: "停止阅读",
    idle: "已停止",
    running: "运行中",
    loading: "等待页面加载",
    scrolling: "滚动中",
    done: "本贴读完，休息",
    night: "夜间静默中",
    cap: "今日已达上限，自动停止",
    waitNav: "等待下次跳转",
    listLoading: "正在获取帖子列表",
    listFail: "列表获取失败，稍后重试",
    list429: "被限流(429)，已退避等待",
    unitSec: " 秒",
    posts: " 楼",
    loaded: "已加载 ",
    readPrefix: "已阅读 ",
    readUnit: " 帖",
    todayPrefix: "今日 ",
    setting: "设置",
    maxDwellTip: "每贴阅读时长在「下限」和「最长停留」之间随机取值。",
    likeOn: "自动点赞：开",
    likeOff: "自动点赞：关",
    likesPrefix: " · 已赞 ",
    likesUnit: " 次",
    timeUp: "限时到，换下一篇",
    tabPrefix: "本页 ",
    tabRunning: "运行中",
    tabIdle: "已停止",
    othersPrefix: " · 其它运行中标签页 ",
    othersUnit: " 个",
    floorsPrefix: " · 本贴 ",
    floorsUnit: " 层",
    floorsTotalPrefix: " · 累计 ",
    floorsTotalUnit: " 层",
  };

  // ============================================================
  // 2. 小工具
  // ============================================================
  function randInt(min, max) {
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min + 1));
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function readFlag() {
    // 只看「当前标签页」自己的开关，别的标签页点停止不会影响这里
    return tabState().on === true;
  }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function timing() {
    return TIMING[getConfig().speed] || TIMING.normal;
  }

  // 每篇帖子的阅读时长区间：下限和上限都在设置里，不受节奏档影响。
  // 真正每贴用的时长在这个区间里随机取，所以每贴停留时间不一样。
  function dwellRange() {
    var cfg = getConfig();
    var lo = cfg.minDwellSec * 1000;
    var hi = cfg.maxDwellSec * 1000;
    if (hi < lo) hi = lo;
    return { lo: lo, hi: hi, loSec: lo / 1000, hiSec: hi / 1000 };
  }

  // ============================================================
  // 2.5 标签页身份与注册表（多标签页各自独立控制）
  // ============================================================
  // 每个标签页有自己的 id（同一个标签页刷新后不变，新标签页是新 id）。
  // 「是否在阅读」「是否自动点赞」都记在 autoReadTabs[自己的 id] 下面，
  // 所以点「停止阅读」只会停当前这个标签页。
  // 阅读数 / 今日数 / 点赞数、待读队列、点赞额度仍然全局共享，不随标签页变多而重复计算。
  var TAB_ID_KEY = "autoReadTabId";
  var HEARTBEAT_MS = 5000;                 // 心跳间隔
  var TAB_ALIVE_MS = 15000;                // 超过这么久没有心跳，就认为那个标签页已经关了
  var TAB_PRUNE_MS = 10 * 60 * 1000;       // 记录超过这么久没动过就清掉
  var TAB_CHANNEL = "autoReadTabChannel";  // 标签页之间互相问「你还在不在」用同一个频道
  var TAB_PROBE_MS = 400;                  // 问完之后最多等这么久

  function makeTabId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function readSessionTabId() {
    try { return sessionStorage.getItem(TAB_ID_KEY); } catch (e) { return null; }
  }
  function writeSessionTabId(id) {
    try { sessionStorage.setItem(TAB_ID_KEY, id); } catch (e) { /* 无 sessionStorage 时忽略 */ }
  }
  function readTabs() {
    try {
      var o = JSON.parse(localStorage.getItem(K.tabs) || "{}");
      return o && typeof o === "object" && !(o instanceof Array) ? o : {};
    } catch (e) {
      return {};
    }
  }
  function writeTabs(tabs) {
    try { localStorage.setItem(K.tabs, JSON.stringify(tabs)); } catch (e) { /* 忽略 */ }
  }

  // 本页的身份就是 sessionStorage 里记着的那个 id。刷新页面时它还留着，所以刷新前后
  // 算「同一个标签页」，阅读状态会接着跑，不会退回「已停止」。
  // （旧版是靠「这条记录是不是刚写过」来猜有没有别的标签页占用同一个 id，然后再换号。
  //   可正在跑的时候心跳每 5 秒就写一次，刷新时记录几乎总是很新，于是有大约一半的几率
  //   被误判成「复制出来的标签页」而换号；新号没有记录，状态就退回「已停止」了。）
  var TAB_ID = (function () {
    var id = readSessionTabId();
    if (!id || !/^[a-z0-9]{4,20}$/.test(id)) id = makeTabId();
    writeSessionTabId(id);
    return id;
  })();

  // 本次页面加载的随机标记：用来区分「这是我自己问的」和「这是别的页面在问」
  var TAB_NONCE = makeTabId();

  var tabChannel = (function () {
    try {
      return typeof BroadcastChannel === "function" ? new BroadcastChannel(TAB_CHANNEL) : null;
    } catch (e) {
      return null;
    }
  })();

  // 有别的页面问「这个 id 也是你的吗」：不是自己问的、又确实是我的 id，就应一声
  if (tabChannel) {
    tabChannel.addEventListener("message", function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== "autoReadProbe" || d.id !== TAB_ID || d.nonce === TAB_NONCE) return;
      try { tabChannel.postMessage({ type: "autoReadAlive", id: TAB_ID, nonce: TAB_NONCE }); } catch (e) { /* 忽略 */ }
    });
  }

  // 开机时确认这个 id 是不是只有本页在用：
  //   刷新页面：原来的页面已经销毁，没有人应声 → 保持原样，接着跑；
  //   复制标签页：原来的页面还活着、会应声 → 换一个新 id，按新标签页处理。
  function settleTabOwnership() {
    if (!tabChannel || !tabEntry(TAB_ID)) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        tabChannel.removeEventListener("message", onMsg);
        resolve(false);
      }, TAB_PROBE_MS);
      function onMsg(ev) {
        var d = ev && ev.data;
        if (settled || !d || d.type !== "autoReadAlive" || d.id !== TAB_ID || d.nonce === TAB_NONCE) return;
        settled = true;
        clearTimeout(timer);
        tabChannel.removeEventListener("message", onMsg);
        resolve(true);
      }
      tabChannel.addEventListener("message", onMsg);
      try { tabChannel.postMessage({ type: "autoReadProbe", id: TAB_ID, nonce: TAB_NONCE }); } catch (e) { /* 忽略 */ }
    });
  }

  // 确认是复制出来的标签页：换个新 id，按「新标签页」的默认状态走
  function splitFromDuplicateTab() {
    TAB_ID = makeTabId();
    writeSessionTabId(TAB_ID);
    var keepRunning = !!getConfig().autoStart;
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    stopScroll();
    if (!keepRunning) setTabState({ on: false });
    heartbeat(true);
    renderOverlay();
    renderReadButton();
    renderLikeButton();
    setStatus(keepRunning ? TXT.running : TXT.idle);
    if (keepRunning) schedule(1500);
    console.log("[AutoRead] 检测到复制出来的标签页，已换号 " + TAB_ID);
  }

  function tabEntry(id) {
    var e = readTabs()[id];
    return e && typeof e === "object" ? e : null;
  }

  // 当前标签页的开关。没有记录过就按默认值走：阅读默认停、点赞默认开。
  function tabState() {
    var e = tabEntry(TAB_ID);
    return {
      on: e && typeof e.on === "boolean" ? e.on : !!getConfig().autoStart,
      like: e && typeof e.like === "boolean" ? e.like : true,
    };
  }
  function setTabState(patch) {
    var tabs = readTabs();
    var e = tabs[TAB_ID];
    if (!e || typeof e !== "object") e = {};
    if (typeof patch.on === "boolean") e.on = patch.on;
    if (typeof patch.like === "boolean") e.like = patch.like;
    e.at = Date.now();
    try { e.url = window.location.href; } catch (err) { /* 忽略 */ }
    try { e.title = document.title; } catch (err) { /* 忽略 */ }
    tabs[TAB_ID] = e;
    writeTabs(tabs);
    return e;
  }

  // 清掉早就关掉的标签页留下的记录
  function pruneTabs() {
    var tabs = readTabs();
    var now = Date.now();
    var changed = false;
    Object.keys(tabs).forEach(function (id) {
      var e = tabs[id];
      if (!e || typeof e !== "object" || typeof e.at !== "number" || now - e.at > TAB_PRUNE_MS) {
        delete tabs[id];
        changed = true;
      }
    });
    if (changed) writeTabs(tabs);
  }

  // 其它「真的在运行」的标签页（心跳没断、开关是开的）
  function liveTabs() {
    var tabs = readTabs();
    var now = Date.now();
    var out = [];
    Object.keys(tabs).forEach(function (id) {
      var e = tabs[id];
      if (!e || typeof e !== "object" || typeof e.at !== "number") return;
      if (now - e.at > TAB_ALIVE_MS) return;
      var on = typeof e.on === "boolean" ? e.on : !!getConfig().autoStart;
      if (!on) return;
      out.push({ id: id, at: e.at, url: e.url || "", title: e.title || "" });
    });
    return out;
  }
  function othersRunning() {
    return liveTabs().filter(function (t) { return t.id !== TAB_ID; }).length;
  }

  var lastBeatAt = 0;
  function heartbeat(force) {
    var now = Date.now();
    var due = readFlag() ? HEARTBEAT_MS : HEARTBEAT_MS * 4;   // 停着的标签页心跳放慢
    if (!force && now - lastBeatAt < due) return;
    lastBeatAt = now;
    setTabState({});
    pruneTabs();
  }
  function startHeartbeat() {
    heartbeat(true);
    setInterval(function () { heartbeat(false); }, HEARTBEAT_MS);
  }

  // ============================================================
  // 3. 配置
  // ============================================================
  function getConfig() {
    var cfg = {
      speed: DEFAULT_CONFIG.speed,
      readingMode: DEFAULT_CONFIG.readingMode,
      dailyCap: DEFAULT_CONFIG.dailyCap,
      nightSilence: DEFAULT_CONFIG.nightSilence,
      minDwellSec: DEFAULT_CONFIG.minDwellSec,
      maxDwellSec: DEFAULT_CONFIG.maxDwellSec,
      likeMinCount: DEFAULT_CONFIG.likeMinCount,
      dailyLikeCap: DEFAULT_CONFIG.dailyLikeCap,
      autoStart: DEFAULT_CONFIG.autoStart,
    };
    try {
      var raw = JSON.parse(localStorage.getItem(K.config) || "{}");
      if (raw && typeof raw === "object") {
        if (raw.speed === "safe" || raw.speed === "normal" || raw.speed === "fast" || raw.speed === "ultra") cfg.speed = raw.speed;
        if (raw.readingMode === "timed" || raw.readingMode === "complete") cfg.readingMode = raw.readingMode;
        var cap = Number(raw.dailyCap);
        if (isFinite(cap) && cap >= 0) cfg.dailyCap = Math.floor(cap);
        if (typeof raw.nightSilence === "boolean") cfg.nightSilence = raw.nightSilence;
        if (typeof raw.autoStart === "boolean") cfg.autoStart = raw.autoStart;
        var minDwell = Number(raw.minDwellSec);
        if (isFinite(minDwell) && minDwell >= 5) cfg.minDwellSec = Math.floor(minDwell);
        var dwell = Number(raw.maxDwellSec);
        if (isFinite(dwell) && dwell >= 5) cfg.maxDwellSec = Math.floor(dwell);
        var minLike = Number(raw.likeMinCount);
        if (isFinite(minLike) && minLike >= 0) cfg.likeMinCount = Math.floor(minLike);
        var likeCap = Number(raw.dailyLikeCap);
        if (Number.isSafeInteger(likeCap) && likeCap >= 0) cfg.dailyLikeCap = likeCap;
      }
    } catch (e) { /* 配置损坏时用默认值 */ }
    return cfg;
  }
  function setConfig(patch) {
    var cfg = getConfig();
    // 逐项校验：非法值（比如停留 3 秒、赞数 -5）直接忽略，保留原来的有效设置
    if (patch.speed === "safe" || patch.speed === "normal" || patch.speed === "fast" || patch.speed === "ultra") cfg.speed = patch.speed;
    if (patch.readingMode === "timed" || patch.readingMode === "complete") cfg.readingMode = patch.readingMode;
    var cap = Number(patch.dailyCap);
    if (isFinite(cap) && cap >= 0) cfg.dailyCap = Math.floor(cap);
    if (typeof patch.nightSilence === "boolean") cfg.nightSilence = patch.nightSilence;
    if (typeof patch.autoStart === "boolean") cfg.autoStart = patch.autoStart;
    var minDwell = Number(patch.minDwellSec);
    if (isFinite(minDwell) && minDwell >= 5) cfg.minDwellSec = Math.floor(minDwell);
    var dwell = Number(patch.maxDwellSec);
    if (isFinite(dwell) && dwell >= 5) cfg.maxDwellSec = Math.floor(dwell);
    var minLike = Number(patch.likeMinCount);
    if (isFinite(minLike) && minLike >= 0) cfg.likeMinCount = Math.floor(minLike);
    var likeCap = Number(patch.dailyLikeCap);
    if (Number.isSafeInteger(likeCap) && likeCap >= 0) cfg.dailyLikeCap = likeCap;
    localStorage.setItem(K.config, JSON.stringify(cfg));
    return cfg;
  }

  // ============================================================
  // 4. 计数与统计
  // ============================================================
  function getReadIds() {
    try {
      var o = JSON.parse(localStorage.getItem(K.readIds) || "{}");
      return o && typeof o === "object" ? o : {};
    } catch (e) {
      return {};
    }
  }
  function getReadCount() {
    return Object.keys(getReadIds()).length;
  }
  function markTopicRead(topicId) {
    if (topicId === undefined || topicId === null || topicId === "") return;
    var ids = getReadIds();
    var key = String(topicId);
    if (ids[key]) return;
    ids[key] = 1;
    localStorage.setItem(K.readIds, JSON.stringify(ids));
    renderOverlay();
  }

  // 楼层计数：Discourse 里每个 .topic-post 就是一个楼层。
  // 记的是「帖号:楼层号」的集合，同一层重复出现只算一次，
  // 所以「累计楼层」只增不减，不会因为来回翻页重复计数。
  function getFloorIds() {
    try {
      var o = JSON.parse(localStorage.getItem(K.floorIds) || "{}");
      return o && typeof o === "object" ? o : {};
    } catch (e) {
      return {};
    }
  }
  function getFloorCount() {
    return Object.keys(getFloorIds()).length;
  }
  function markFloorsRead(keys) {
    if (!keys || !keys.length) return 0;
    var ids = getFloorIds();
    var added = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = String(keys[i]);
      if (!key || ids[key]) continue;
      ids[key] = 1;
      added++;
    }
    if (added > 0) {
      localStorage.setItem(K.floorIds, JSON.stringify(ids));
      renderOverlay();
    }
    return added;
  }
  // 当前帖子里「第几楼」的列表：优先用真实楼层号，取不到就按顺序编号
  function floorKeysOf(topicId) {
    var posts = document.querySelectorAll(".topic-post");
    var out = [];
    var seen = {};
    for (var i = 0; i < posts.length; i++) {
      var el = posts[i];
      var n = null;
      try {
        var attr = el.getAttribute ? el.getAttribute("data-post-number") : null;
        if (attr && /^[0-9]+$/.test(String(attr))) n = String(attr);
        if (n === null && el.id && /^post_([0-9]+)$/.test(el.id)) n = el.id.replace("post_", "");
      } catch (e) { /* 忽略 */ }
      if (n === null) n = String(i + 1);
      var key = topicId + ":" + n;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  var stats = (function loadStats() {
    var s = { day: dayKey(), today: 0, total: 0, likes: 0 };
    try {
      var raw = JSON.parse(localStorage.getItem(K.stats) || "{}");
      if (raw && typeof raw === "object") {
        s.total = Number(raw.total) || 0;
        s.likes = Number(raw.likes) || 0;
        if (raw.day === s.day) s.today = Number(raw.today) || 0;
      }
    } catch (e) { /* 忽略 */ }
    return s;
  })();
  function saveStats() {
    localStorage.setItem(K.stats, JSON.stringify(stats));
  }
  function bumpToday() {
    if (stats.day !== dayKey()) { stats.day = dayKey(); stats.today = 0; }
    stats.today++;
    stats.total++;
    saveStats();
  }
  function bumpLike() {
    stats.likes = (Number(stats.likes) || 0) + 1;
    saveStats();
  }
  function capReached() {
    var cap = getConfig().dailyCap;
    return cap > 0 && stats.today >= cap;
  }
  function nightActive() {
    if (!getConfig().nightSilence) return false;
    var h = new Date().getHours();
    return h >= 0 && h < 7;
  }

  // ============================================================
  // 5. 跳转节流：两次打开帖子之间必须有最小间隔
  // ============================================================
  function lastNavAt() {
    return Number(localStorage.getItem(K.lastNav) || "0") || 0;
  }
  function navWaitMs() {
    return Math.max(0, timing().actionGapMs - (Date.now() - lastNavAt()));
  }
  function noteNav() {
    localStorage.setItem(K.lastNav, String(Date.now()));
  }

  // ============================================================
  // 6. 网络请求（同步 XHR 封装，带状态返回）
  // ============================================================
  var errStreak = 0;

  function safeGetJSON(path) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", path, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 400) {
        try {
          return { ok: true, status: xhr.status, data: JSON.parse(xhr.responseText) };
        } catch (e) {
          return { ok: false, status: -2 };
        }
      }
      return { ok: false, status: xhr.status };
    } catch (e) {
      return { ok: false, status: -1 };
    }
  }

  function backoffMs() {
    var b = timing().backoff;
    return b[Math.min(errStreak, b.length - 1)];
  }

  // ============================================================
  // 7. 帖子列表
  // ============================================================
  var listCache = (function loadListCache() {
    try {
      var o = JSON.parse(localStorage.getItem(K.listCache) || "null");
      if (o && typeof o.at === "number" && Object.prototype.toString.call(o.list) === "[object Array]") return o;
    } catch (e) { /* 忽略 */ }
    return null;
  })();

  function readStoredList() {
    try {
      var l = JSON.parse(localStorage.getItem(K.topicList) || "[]");
      return Object.prototype.toString.call(l) === "[object Array]" ? l : [];
    } catch (e) {
      return [];
    }
  }
  function writeStoredList(l) {
    localStorage.setItem(K.topicList, JSON.stringify(l));
  }

  // 抓取候选帖：最多抓 2 页，页与页之间有 5~12 秒随机间隔
  async function fetchTopics() {
    var t = timing();
    var collected = [];
    var seen = {};
    var lastStatus = 0;

    for (var page = 0; page < t.maxPages; page++) {
      var res = safeGetJSON(BASE_URL + "/latest.json?no_definitions=true&page=" + page);
      if (!res.ok) {
        lastStatus = res.status;
        if (res.status > 0) errStreak++;
        return { ok: false, status: lastStatus };
      }
      errStreak = 0;
      var tl = res.data && res.data.topic_list;
      if (!tl || !tl.topics || !tl.topics.length) break;

      for (var i = 0; i < tl.topics.length; i++) {
        var topic = tl.topics[i];
        if (!topic || !topic.id || seen[topic.id]) continue;
        if (topic.posts_count < COMMENT_LIMIT) {
          seen[topic.id] = true;
          collected.push({ id: topic.id, last_read_post_number: topic.last_read_post_number });
        }
      }
      if (collected.length >= TOPIC_LIST_LIMIT) break;
      if (page < t.maxPages - 1) await sleep(randInt(t.pageGapMin, t.pageGapMax));
    }

    // 读过的排到后面，顺序再打乱，避免固定顺序的机械轨迹
    var readIds = getReadIds();
    var fresh = [];
    var old = [];
    for (var j = 0; j < collected.length; j++) {
      if (readIds[collected[j].id]) old.push(collected[j]); else fresh.push(collected[j]);
    }
    fresh.sort(function () { return Math.random() - 0.5; });
    old.sort(function () { return Math.random() - 0.5; });
    return { ok: true, status: 200, list: fresh.concat(old).slice(0, TOPIC_LIST_LIMIT) };
  }

  // ============================================================
  // 8. 页面跳转（优先 SPA routeTo，失败回退整页跳转）
  // ============================================================
  var pendingNav = null;
  var lastTopicId = null;
  var lastTopicFloors = 0;    // 本贴已经出现过的最多楼层数（进新帖清零）
  var topicEnteredAt = Date.now();
  var stuckRounds = 0;

  function currentTopicId() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "t") return null;
    // 支持 /t/12345、/t/12345/12、/t/topic/12345、/t/标题/12345/12
    if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[1];
    if (parts.length >= 3) {
      if (/^\d+$/.test(parts[1])) return parts[1];
      if (/^\d+$/.test(parts[2])) return parts[2];
    }
    return null;
  }

  function goToTopic(id, postNumber) {
    var path = postNumber
      ? BASE_URL + "/t/topic/" + id + "/" + postNumber
      : BASE_URL + "/t/topic/" + id;

    noteNav();
    lastTopicId = String(id);
    topicEnteredAt = Date.now();
    lastTopicFloors = 0;
    pendingNav = { id: String(id), at: Date.now() };
    try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ }

    var routeTo = null;
    try {
      if (typeof window.require === "function") {
        var mod = window.require("discourse/lib/url");
        var U = (mod && mod.default) || mod;
        if (U && typeof U.routeTo === "function") routeTo = U.routeTo;
      }
    } catch (e) {
      routeTo = null;
    }
    if (routeTo) {
      try {
        routeTo(path);
        return;
      } catch (e) {
        console.warn("[AutoRead] routeTo 失败，改用整页跳转");
      }
    }
    window.location.href = path;
  }

  // 选下一篇：优先用本地队列，队列空了才去抓列表
  async function openNextTopic() {
    if (navWaitMs() > 0) return false;

    var list = readStoredList();
    if (!list.length) {
      var t = timing();
      if (listCache && listCache.list.length && Date.now() - listCache.at < t.listRefreshMs) {
        list = listCache.list.slice();
      } else {
        setStatus(TXT.listLoading);
        var res = await fetchTopics();
        if (!res.ok || !res.list.length) {
          setStatus(res.status === 429 ? TXT.list429 : TXT.listFail);
          return false;
        }
        listCache = { at: Date.now(), list: res.list.slice() };
        localStorage.setItem(K.listCache, JSON.stringify(listCache));
        list = res.list.slice();
      }
    }

    var topic = list.shift();
    writeStoredList(list);
    if (!topic || !topic.id) return false;
    goToTopic(topic.id, topic.last_read_post_number);
    return true;
  }

  // ============================================================
  // 9. 滚动（单一定时器链，不会被反复打断）
  // ============================================================
  var scrollTimer = null;

  function scrollTick() {
    scrollTimer = null;
    if (!readFlag()) return;
    var t = timing();
    window.scrollBy(0, randInt(t.minStepPx, t.maxStepPx));
    var pause = Math.random() < t.longPauseChance
      ? randInt(t.longPauseMin, t.longPauseMax)
      : randInt(t.minStepMs, t.maxStepMs);
    scrollTimer = setTimeout(scrollTick, pause);
  }
  function startScroll() {
    if (scrollTimer === null) scrollTick();
  }
  function stopScroll() {
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  }

  function docHeight() {
    var a = document.documentElement ? document.documentElement.scrollHeight : 0;
    var b = document.body ? document.body.scrollHeight : 0;
    return Math.max(a, b);
  }
  function atBottom() {
    return window.innerHeight + window.scrollY >= docHeight() - 200;
  }
  function topicReady() {
    return docHeight() > 1200 && !!document.querySelector(".topic-post, #post_1, .topic-body");
  }
  function loadedPosts() {
    return document.querySelectorAll(".topic-post").length;
  }

  // ============================================================
  // 10. 主循环
  // ============================================================
  var checkTimer = null;
  var cycleRunning = false;
  var lastProgressY = -1;
  var lastProgressAt = Date.now();
  var stuck = 0;
  var forceFinish = false;
  var lastLikeScanAt = 0;
  var topicDwellTarget = 0;   // 本贴的目标阅读时长（进入新帖时随机生成）
  var completeLastFloorCount = -1;
  var completeStableChecks = 0;

  // 本贴当前加载出的楼层数（取本次进入帖子后的最大值）。
  // 刚跳转过来的 2 秒内 DOM 还可能残留上一篇的楼层，先不采样，避免算到别的贴上。
  function floorsReadNow() {
    if (Date.now() - topicEnteredAt < 2000) return lastTopicFloors;
    var n = loadedPosts();
    if (n > lastTopicFloors) lastTopicFloors = n;
    return lastTopicFloors;
  }

  function schedule(ms) {
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = setTimeout(function () { cycle(); }, ms);
  }
  function scheduleRand(min, max) {
    schedule(randInt(min, max));
  }

  function stopReading() {
    stopScroll();
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    setTabState({ on: false });
    renderReadButton();
  }

  async function cycle() {
    checkTimer = null;
    if (cycleRunning) return;
    cycleRunning = true;
    var next = 5000;
    try {
      next = await cycleOnce();
    } catch (e) {
      console.warn("[AutoRead] 循环异常，稍后重试", e);
      next = 10000;
    } finally {
      cycleRunning = false;
    }
    if (readFlag()) scheduleRand(next, next + 2000);
  }

  async function cycleOnce() {
    if (!readFlag()) { stopScroll(); setStatus(TXT.idle); return 60000; }

    if (nightActive()) {
      stopScroll();
      setStatus(TXT.night);
      return 60000;
    }

    if (capReached()) {
      stopReading();
      setStatus(TXT.cap + " " + stats.today + TXT.readUnit);
      return 600000;
    }

    var id = currentTopicId();

    // --- 不在帖子页：准备并打开下一篇 ---
    if (!id) {
      stopScroll();
      var wait = navWaitMs();
      if (wait > 0) {
        setStatus(TXT.waitNav + " " + Math.ceil(wait / 1000) + TXT.unitSec);
        return Math.min(wait, 10000);
      }
      var opened = await openNextTopic();
      if (!opened) return randInt(30000, 60000);
      setStatus(TXT.loading);
      return 3000;
    }

    // --- SPA 跳转没生效的兜底 ---
    if (pendingNav && pendingNav.id !== id && Date.now() - pendingNav.at > 12000) {
      console.warn("[AutoRead] 单页跳转未生效，改用整页跳转");
      var path = BASE_URL + "/t/topic/" + pendingNav.id;
      pendingNav = null;
      noteNav();
      window.location.href = path;
      return 15000;
    }

    // --- 进入新帖，重置本贴状态 ---
    if (id !== lastTopicId) {
      lastTopicId = id;
      topicEnteredAt = Date.now();
      lastTopicFloors = 0;
      lastProgressY = -1;
      lastProgressAt = Date.now();
      stuck = 0;
      stuckRounds = 0;
      forceFinish = false;
      pendingNav = null;
      topicDwellTarget = 0;   // 重新随机本贴的阅读时长
      completeLastFloorCount = -1;
      completeStableChecks = 0;
      autoLike();   // 首屏就够条件的楼层，进来就处理掉
    }

    var t = timing();

    if (!topicReady()) {
      stopScroll();
      // 页面久久加载不出来（权限不足、帖子已删、被跳到别的页面等）：
      // 直接放弃这一贴去下一贴，避免永远卡在“等待页面加载”。
      if (Date.now() - topicEnteredAt > t.notReadyMs) {
        console.warn("[AutoRead] 页面长时间未就绪，跳过这一贴");
        lastTopicId = null;
        var w0 = navWaitMs();
        if (w0 > 0) {
          setStatus(TXT.waitNav + " " + Math.ceil(w0 / 1000) + TXT.unitSec);
          return Math.min(w0, 10000);
        }
        await openNextTopic();
        return 3000;
      }
      setStatus(TXT.loading);
      return randInt(1500, 3500);
    }

    var dwell = Date.now() - topicEnteredAt;
    // 本贴目标阅读时长：在「下限」和「最长停留」之间随机取一个
    var range = dwellRange();
    if (!topicDwellTarget) topicDwellTarget = randInt(range.lo, range.hi);
    var timeUp = dwell >= topicDwellTarget;
    var cfg = getConfig();

    // 完整阅读：滚到底后等待懒加载楼层数量稳定，再允许换帖。
    if (cfg.readingMode === "complete") {
      var floorCount = loadedPosts();
      if (floorCount > lastTopicFloors) lastTopicFloors = floorCount;
      if (floorCount !== completeLastFloorCount) {
        completeLastFloorCount = floorCount;
        completeStableChecks = 0;
      }
      if (!atBottom()) {
        completeStableChecks = 0;
        startScroll();
        setStatus(TXT.scrolling + " · " + TXT.loaded + floorCount + TXT.posts);
        return randInt(t.checkMin, t.checkMax);
      }
      completeStableChecks++;
      if (completeStableChecks < 2 || dwell < Math.max(15000, range.lo)) {
        stopScroll();
        setStatus("完整阅读 · 已加载 " + floorCount + TXT.posts);
        return randInt(t.checkMin, t.checkMax);
      }
      timeUp = false;
      forceFinish = false;
    }

    // --- 判定读完：到点限时、正常滚到底、或连续多轮推不动 ---
    if (timeUp || (dwell >= range.lo && (atBottom() || forceFinish))) {
      stopScroll();
      markTopicRead(id);
      bumpToday();
      markFloorsRead(floorKeysOf(id));
      var rest = randInt(t.topicRestMin, t.topicRestMax);
      setStatus((timeUp ? TXT.timeUp : TXT.done) + " " + Math.ceil(rest / 1000) + TXT.unitSec);
      await sleep(rest);
      if (!readFlag()) return 5000;
      if (capReached()) {
        stopReading();
        setStatus(TXT.cap + " " + stats.today + TXT.readUnit);
        return 600000;
      }
      var w2 = navWaitMs();
      if (w2 > 0) await sleep(w2);
      await openNextTopic();
      return 3000;
    }

    startScroll();

    // 滚动过程中新楼层会陆续加载出来，每隔一会儿回头扫一遍该点的赞
    if (Date.now() - lastLikeScanAt > 8000) {
      lastLikeScanAt = Date.now();
      autoLike();
    }

    // --- 卡死检测 ---
    var y = window.scrollY || (document.documentElement ? document.documentElement.scrollTop : 0) || 0;
    if (y > lastProgressY + 4) {
      lastProgressY = y;
      lastProgressAt = Date.now();
      stuck = 0;
    } else {
      stuck++;
    }

    if (stuck >= t.stallLimit || Date.now() - lastProgressAt > t.stallTimeoutMs) {
      console.warn("[AutoRead] 长时间没有进展，尝试恢复");
      stuck = 0;
      lastProgressAt = Date.now();
      stopScroll();
      await sleep(randInt(600, 1800));
      if (!readFlag()) return 5000;

      // 直接推到文档底部附近，触发 Discourse 的懒加载
      try {
        window.scrollTo(0, Math.max(0, docHeight() - window.innerHeight - 50));
      } catch (e) { /* 忽略 */ }
      await sleep(randInt(1500, 3000));

      var y2 = window.scrollY || 0;
      if (y2 <= lastProgressY + 4 && Date.now() - topicEnteredAt >= dwellRange().lo) {
        stuckRounds++;
      } else {
        stuckRounds = 0;
      }

      // 连续多轮完全推不动：本贴没有更多内容了，按读完处理，避免原地空转
      if (stuckRounds >= 3) {
        console.warn("[AutoRead] 连续多轮无进展，判定本贴已到末尾");
        forceFinish = true;
        return 1500;
      }
      startScroll();
      return randInt(2000, 4000);
    }

    floorsReadNow();
    setStatus(TXT.scrolling + " · " + TXT.loaded + loadedPosts() + TXT.posts);
    return randInt(t.checkMin, t.checkMax);
  }

  // ============================================================
  // 11. 界面
  // ============================================================
  // 柔和工具风（StyleKit soft-utility）：深青主色 + 浅色底，状态主要由文字表达，
  // 颜色只做辅助；按钮有悬停、按下和键盘聚焦反馈。
  var UI = {
    surface: "rgba(248,252,250,.96)", ink: "#203b40", sub: "#557077",
    primary: "#2d5b63", primaryDark: "#234b52", mint: "#a9d8cc",
    line: "rgba(45,91,99,0.16)", warn: "#a4471f", warnBg: "#fdf1e3",
  };
  var UI_FONT = "font:12px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;";
  var uiStyle = document.createElement("style");
  uiStyle.textContent = [
    ".ar-shell{position:fixed;left:14px;bottom:14px;z-index:2147483000;width:min(320px,calc(100vw - 28px));color:" + UI.ink + ";" + UI_FONT,
    "filter:drop-shadow(0 8px 24px rgba(32,59,64,.12));}",
    ".ar-overlay{background:" + UI.surface + ";border:1px solid " + UI.line + ";border-radius:14px;padding:10px 12px;white-space:pre-line;font-variant-numeric:tabular-nums;cursor:grab;user-select:none;touch-action:none;transition:border-color .18s,background-color .18s;}",
    ".ar-overlay.ar-dragging{cursor:grabbing;transition:none;}",
    ".ar-overlay:hover,.ar-overlay:focus-visible{background:#fff;border-color:" + UI.mint + ";}",
    ".ar-overlay.ar-on{border-color:" + UI.primary + ";}",
    ".ar-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:7px;}",
    ".ar-btn{position:static;min-width:0;min-height:36px;" + UI_FONT + "font-weight:600;color:#fff;background:" + UI.primary + ";border:1px solid " + UI.primary + ";border-radius:9px;padding:6px 8px;white-space:nowrap;cursor:pointer;box-shadow:0 2px 6px rgba(32,59,64,.10);transition:background-color .18s,transform .18s;}",
    ".ar-btn:hover{background:" + UI.primaryDark + ";}",
    ".ar-btn:active{transform:scale(.98);}",
    ".ar-btn:focus-visible,.ar-overlay:focus-visible{outline:2px solid " + UI.mint + ";outline-offset:2px;}",
    ".ar-btn-idle{color:" + UI.primary + ";background:" + UI.surface + ";}",
    ".ar-btn-idle:hover{background:" + UI.mint + ";color:" + UI.primaryDark + ";}",
    ".ar-panel{position:static;margin-top:7px;background:#fff;color:" + UI.ink + ";line-height:1.9;border:1px solid " + UI.line + ";border-radius:12px;padding:10px 12px;box-shadow:0 4px 16px rgba(32,59,64,.10);max-width:none;}",
    ".ar-panel input[type=number],.ar-panel select{font:inherit;color:" + UI.ink + ";background:#fff;border:1px solid " + UI.line + ";border-radius:8px;padding:2px 6px;}",
    ".ar-panel input[type=checkbox]{accent-color:" + UI.primary + ";}",
    ".ar-panel input:focus-visible,.ar-panel select:focus-visible{outline:2px solid " + UI.mint + ";outline-offset:1px;}",
    ".ar-hint{color:" + UI.sub + ";}",
    ".ar-note{margin-top:6px;padding:4px 7px;border-radius:8px;background:" + UI.warnBg + ";color:" + UI.warn + ";}",
    "@media (max-width:480px){.ar-shell{left:10px;bottom:10px;width:calc(100vw - 20px);}.ar-panel{max-height:60vh;overflow:auto;}}",
    "@media (prefers-reduced-motion: reduce){.ar-btn,.ar-overlay{transition:none;}.ar-btn:active{transform:none;}}",
  ].join("");
  document.body.appendChild(uiStyle);

  var overlay = document.createElement("div");
  overlay.className = "ar-overlay";
  var overlayStatus = TXT.idle;
  var details;
  var shell;
  var ignoreNextOverlayClick = false;
  var dragState = null;

  function viewportSize() {
    var doc = document.documentElement || {};
    return {
      width: Math.max(0, Number(window.innerWidth) || Number(doc.clientWidth) || 1024),
      height: Math.max(0, Number(window.innerHeight) || Number(doc.clientHeight) || 768),
    };
  }
  function cardRect() {
    if (shell && typeof shell.getBoundingClientRect === "function") {
      var rect = shell.getBoundingClientRect();
      if (rect && isFinite(rect.left) && isFinite(rect.top)) return rect;
    }
    var width = shell && Number(shell.offsetWidth) || 320;
    var height = shell && Number(shell.offsetHeight) || 90;
    var left = shell && parseFloat(shell.style.left);
    var top = shell && parseFloat(shell.style.top);
    if (!isFinite(left)) left = 14;
    if (!isFinite(top)) top = viewportSize().height - (parseFloat(shell && shell.style.bottom) || 14) - height;
    return { left: left, top: top, width: width, height: height };
  }
  function clampCardPosition(left, top) {
    var vp = viewportSize();
    var rect = cardRect();
    var width = Math.max(0, Number(rect.width) || 320);
    var height = Math.max(0, Number(rect.height) || 90);
    var maxLeft = Math.max(8, vp.width - width - 8);
    var maxTop = Math.max(8, vp.height - height - 8);
    return {
      left: Math.min(maxLeft, Math.max(8, Number(left) || 0)),
      top: Math.min(maxTop, Math.max(8, Number(top) || 0)),
    };
  }
  function applyCardPosition(left, top, persist) {
    if (!shell) return;
    var pos = clampCardPosition(left, top);
    shell.style.left = pos.left + "px";
    shell.style.top = pos.top + "px";
    shell.style.right = "auto";
    shell.style.bottom = "auto";
    if (persist) {
      try { localStorage.setItem(K.uiPosition, JSON.stringify(pos)); } catch (e) {}
    }
  }
  function restoreCardPosition() {
    try {
      var saved = JSON.parse(localStorage.getItem(K.uiPosition) || "null");
      if (saved && isFinite(Number(saved.left)) && isFinite(Number(saved.top))) {
        applyCardPosition(Number(saved.left), Number(saved.top), false);
      }
    } catch (e) {}
  }
  function endCardDrag(event) {
    if (!dragState) return;
    if (event && dragState.moved) {
      applyCardPosition(dragState.left, dragState.top, true);
      ignoreNextOverlayClick = true;
      setTimeout(function () { ignoreNextOverlayClick = false; }, 0);
    }
    overlay.className = "ar-overlay" + (readFlag() ? " ar-on" : "");
    dragState = null;
  }
  function setupCardDragging() {
    overlay.addEventListener("pointerdown", function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      var rect = cardRect();
      dragState = {
        pointerId: event.pointerId,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        originLeft: Number(rect.left) || 0,
        originTop: Number(rect.top) || 0,
        left: Number(rect.left) || 0,
        top: Number(rect.top) || 0,
        moved: false,
      };
      if (typeof overlay.setPointerCapture === "function" && event.pointerId !== undefined) {
        try { overlay.setPointerCapture(event.pointerId); } catch (e) {}
      }
    });
    overlay.addEventListener("pointermove", function (event) {
      if (!dragState || (dragState.pointerId !== undefined && event.pointerId !== undefined && dragState.pointerId !== event.pointerId)) return;
      var dx = (Number(event.clientX) || 0) - dragState.startX;
      var dy = (Number(event.clientY) || 0) - dragState.startY;
      if (!dragState.moved && Math.sqrt(dx * dx + dy * dy) < 4) return;
      dragState.moved = true;
      var pos = clampCardPosition(dragState.originLeft + dx, dragState.originTop + dy);
      dragState.left = pos.left;
      dragState.top = pos.top;
      applyCardPosition(pos.left, pos.top, false);
      overlay.className = "ar-overlay ar-dragging" + (readFlag() ? " ar-on" : "");
      if (event.preventDefault) event.preventDefault();
    });
    overlay.addEventListener("pointerup", endCardDrag);
    overlay.addEventListener("pointercancel", endCardDrag);
    window.addEventListener("resize", function () {
      if (!shell || !shell.style.left || !shell.style.top) return;
      var rect = cardRect();
      applyCardPosition(rect.left, rect.top, true);
    });
  }

  function renderOverlay() {
    var others = othersRunning();
    var on = readFlag();
    overlay.className = "ar-overlay" + (on ? " ar-on" : "");
    overlay.textContent =
      "自动阅读 · " + getReadCount() + TXT.readUnit +
      "\n" + TXT.todayPrefix + stats.today + TXT.readUnit +
      TXT.floorsTotalPrefix + getFloorCount() + TXT.floorsTotalUnit +
      TXT.likesPrefix + (Number(stats.likes) || 0) + TXT.likesUnit +
      "\n" + (on ? TXT.tabRunning : TXT.tabIdle) +
      (others > 0 ? TXT.othersPrefix + others + TXT.othersUnit : "") +
      " · " + overlayStatus + "\n拖动卡片 · 点击展开设置";
  }
  function setStatus(s) {
    overlayStatus = s;
    renderOverlay();
  }

  var button = document.createElement("button");
  button.type = "button";
  button.className = "ar-btn";
  // 停着的时候「开始阅读」是主操作（实心），跑着的时候用浅色按钮，避免误触
  function renderReadButton() {
    var on = readFlag();
    button.textContent = on ? TXT.stop : TXT.start;
    button.className = "ar-btn" + (on ? "" : " ar-btn-idle");
  }
  renderReadButton();

  button.onclick = function () {
    var currentlyReading = readFlag();
    var next = !currentlyReading;
    // 只改当前标签页的开关，别的标签页不受影响
    setTabState({ on: next });
    heartbeat(true);
    renderOverlay();
    renderReadButton();
    if (!next) {
      stopScroll();
      if (checkTimer !== null) { clearTimeout(checkTimer); checkTimer = null; }
      setStatus(TXT.idle);
    } else {
      // 从顶部重新开始：先回到一个已知帖子，再让循环接管
      if (BASE_URL === "https://linux.do") {
        goToTopic(13716, 900);
      } else {
        goToTopic(1, null);
      }
      setStatus(TXT.running);
      if (readFlag()) schedule(2000);
    }
  };

  // 自动点赞（默认关闭，需手动开启）
  var toggleAutoLikeButton = document.createElement("button");
  toggleAutoLikeButton.type = "button";
  toggleAutoLikeButton.className = "ar-btn ar-btn-idle";
  function renderLikeButton() {
    var on = isAutoLikeEnabled();
    var head = on ? TXT.likeOn : TXT.likeOff;
    toggleAutoLikeButton.textContent = head;
    toggleAutoLikeButton.className = "ar-btn" + (on ? "" : " ar-btn-idle");
  }
  toggleAutoLikeButton.addEventListener("click", function () {
    setAutoLikeEnabled(!isAutoLikeEnabled());
    if (isAutoLikeEnabled()) autoLike();
    renderLikeButton();
  });

  var settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.textContent = TXT.setting;
  settingsButton.className = "ar-btn ar-btn-idle";


  var panel = document.createElement("div");
  panel.className = "ar-panel";
  panel.style.display = "none";

  var speedSelect = document.createElement("select");
  var optSafe = document.createElement("option");
  optSafe.value = "safe";
  optSafe.textContent = "保守（更慢）";
  var optNormal = document.createElement("option");
  optNormal.value = "normal";
  optNormal.textContent = "标准";
  var optFast = document.createElement("option");
  optFast.value = "fast";
  optFast.textContent = "快速（标准 2×）";
  var optUltra = document.createElement("option");
  optUltra.value = "ultra";
  optUltra.textContent = "极速（标准 3×）";
  speedSelect.appendChild(optSafe);
  speedSelect.appendChild(optNormal);
  speedSelect.appendChild(optFast);
  speedSelect.appendChild(optUltra);

  var modeSelect = document.createElement("select");
  var modeTimed = document.createElement("option");
  modeTimed.value = "timed";
  modeTimed.textContent = "按时间阅读";
  var modeComplete = document.createElement("option");
  modeComplete.value = "complete";
  modeComplete.textContent = "完整阅读";
  modeSelect.appendChild(modeTimed);
  modeSelect.appendChild(modeComplete);

  var capInput = document.createElement("input");
  capInput.type = "number";
  capInput.min = "0";
  capInput.step = "10";
  capInput.style.width = "70px";

  var nightBox = document.createElement("input");
  nightBox.type = "checkbox";

  var autoStartBox = document.createElement("input");
  autoStartBox.type = "checkbox";

  var dwellInput = document.createElement("input");
  dwellInput.type = "number";
  dwellInput.min = "5";
  dwellInput.step = "5";
  dwellInput.style.width = "70px";

  var minDwellInput = document.createElement("input");
  minDwellInput.type = "number";
  minDwellInput.min = "5";
  minDwellInput.step = "5";
  minDwellInput.style.width = "70px";

  var minLikeInput = document.createElement("input");
  minLikeInput.type = "number";
  minLikeInput.min = "0";
  minLikeInput.step = "5";
  minLikeInput.style.width = "70px";

  var likeCapInput = document.createElement("input");
  likeCapInput.type = "number";
  likeCapInput.min = "0";
  likeCapInput.step = "1";
  likeCapInput.style.width = "70px";

  function renderPanel() {
    var cfg = getConfig();
    var range = dwellRange();
    speedSelect.value = cfg.speed;
    modeSelect.value = cfg.readingMode;
    capInput.value = String(cfg.dailyCap);
    nightBox.checked = cfg.nightSilence;
    autoStartBox.checked = cfg.autoStart;
    dwellInput.value = String(range.hiSec);
    minDwellInput.value = String(range.loSec);
    minLikeInput.value = String(cfg.likeMinCount);
    likeCapInput.value = String(cfg.dailyLikeCap);
  }

  panel.appendChild(document.createTextNode("阅读模式："));
  panel.appendChild(modeSelect);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("阅读速度："));
  panel.appendChild(speedSelect);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("每日上限（帖，0=不限）："));
  panel.appendChild(capInput);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("每贴最长停留（秒）："));
  panel.appendChild(dwellInput);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("每贴最少阅读（秒）："));
  panel.appendChild(minDwellInput);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("只赞超过 N 赞的楼层："));
  panel.appendChild(minLikeInput);
  panel.appendChild(document.createElement("br"));
  panel.appendChild(document.createTextNode("过去 24 小时点赞上限（次，0=暂停）："));
  panel.appendChild(likeCapInput);
  panel.appendChild(document.createElement("br"));
  var dwellTip = document.createElement("div");
  dwellTip.className = "ar-hint";
  dwellTip.textContent = TXT.maxDwellTip;
  panel.appendChild(dwellTip);
  panel.appendChild(nightBox);
  panel.appendChild(document.createTextNode(" 00:00-07:00 暂停"));
  panel.appendChild(document.createElement("br"));
  panel.appendChild(autoStartBox);
  panel.appendChild(document.createTextNode(" 新标签页自动开始阅读"));
  panel.appendChild(document.createElement("br"));
  var note = document.createElement("div");
  note.className = "ar-note";
  note.textContent = "linux.do 禁止自动化访问，请保持低速使用。";
  panel.appendChild(note);

  function applyPanel() {
    var cap = Number(capInput.value);
    if (!isFinite(cap) || cap < 0) cap = DEFAULT_CONFIG.dailyCap;
    var dwell = Number(dwellInput.value);
    if (!isFinite(dwell) || dwell < 5) dwell = DEFAULT_CONFIG.maxDwellSec;
    var minDwell = Number(minDwellInput.value);
    if (!isFinite(minDwell) || minDwell < 5) minDwell = DEFAULT_CONFIG.minDwellSec;
    // 下限不能超过上限，否则上限跟着抬起来
    if (minDwell > dwell) dwell = minDwell;
    var minLike = Number(minLikeInput.value);
    if (!isFinite(minLike) || minLike < 0) minLike = DEFAULT_CONFIG.likeMinCount;
    var likeCap = Number(likeCapInput.value);
    if (likeCapInput.value.trim() === "" || !Number.isSafeInteger(likeCap) || likeCap < 0) {
      likeCap = getConfig().dailyLikeCap;
    }
    setConfig({
      speed: speedSelect.value === "safe" ? "safe" : (speedSelect.value === "ultra" ? "ultra" : (speedSelect.value === "fast" ? "fast" : "normal")),
      readingMode: modeSelect.value === "complete" ? "complete" : "timed",
      dailyCap: Math.floor(cap),
      nightSilence: nightBox.checked,
      autoStart: autoStartBox.checked,
      minDwellSec: Math.floor(minDwell),
      maxDwellSec: Math.floor(dwell),
      likeMinCount: Math.floor(minLike),
      dailyLikeCap: likeCap,
    });
    renderPanel();
    renderLikeButton();
    renderOverlay();
  }
  speedSelect.addEventListener("change", applyPanel);
  modeSelect.addEventListener("change", applyPanel);
  capInput.addEventListener("change", applyPanel);
  nightBox.addEventListener("change", applyPanel);
  autoStartBox.addEventListener("change", applyPanel);
  dwellInput.addEventListener("change", applyPanel);
  minDwellInput.addEventListener("change", applyPanel);
  minLikeInput.addEventListener("change", applyPanel);
  likeCapInput.addEventListener("change", applyPanel);

  function togglePanel() {
    var shown = panel.style.display !== "none";
    panel.style.display = shown ? "none" : "block";
    settingsButton.setAttribute("aria-expanded", String(!shown));
    if (!shown) renderPanel();
  }
  function toggleDetails() {
    var shown = details.style.display !== "none";
    details.style.display = shown ? "none" : "block";
    overlay.setAttribute("aria-expanded", String(!shown));
    if (!shown) {
      panel.style.display = "block";
      settingsButton.setAttribute("aria-expanded", "true");
      renderPanel();
      // 展开设置后卡片会变高，重新限制位置，避免面板跑出窗口底部。
      var rect = cardRect();
      applyCardPosition(rect.left, rect.top, true);
    } else {
      panel.style.display = "none";
      settingsButton.setAttribute("aria-expanded", "false");
    }
  }
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.addEventListener("click", togglePanel);
  overlay.addEventListener("click", function () {
    if (ignoreNextOverlayClick) {
      ignoreNextOverlayClick = false;
      return;
    }
    toggleDetails();
  });
  overlay.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleDetails();
    }
  });

  // 别的标签页改了状态（开始/停止、自动点赞、设置、统计）时，这里同步刷新显示
  window.addEventListener("storage", function (e) {
    if (!e || !e.key) return;
    if (e.key === K.readIds || e.key === K.stats || e.key === K.tabs || e.key === K.config) {
      renderOverlay();
      renderLikeButton();
      if (panel.style.display !== "none") renderPanel();
    }
  });

  // ============================================================
  // 12. 首次运行初始化 / 自动点赞
  // ============================================================
  // 2.2.0：把 2.1.0 及更早版本里「全局」的 read / autoLikeEnabled 迁移成当前标签页的状态。
  // 只做一次（哪个标签页先加载就由哪个迁移），之后新开的标签页默认是「停止」。
  function migrateToPerTab() {
    if (localStorage.getItem(K.tabs) !== null) return;
    var firstRun = localStorage.getItem(K.firstRun) === null;
    var on = !firstRun && localStorage.getItem(K.read) === "true";
    var like = firstRun ? true : localStorage.getItem(K.like) !== "false";
    setTabState({ on: on, like: like });
    localStorage.setItem(K.firstRun, "false");
    localStorage.setItem(K.likeDefault210, "1");
    console.log("[AutoRead] 已改为按标签页控制：本页 on=" + on + " like=" + like);
  }

  function isAutoLikeEnabled() {
    // 当前标签页自己的开关；没设置过默认开启（沿用 2.1.0 的习惯）
    return tabState().like === true;
  }
  function setAutoLikeEnabled(enabled) {
    setTabState({ like: !!enabled });
  }

  var clickCounter = 0;
  function refreshLikeBudget() {
    var now = Date.now();
    var stamp = Number(localStorage.getItem(K.clickStamp));
    var count = Number(localStorage.getItem(K.clickCounter));
    if (!Number.isSafeInteger(stamp) || stamp <= 0 || stamp > now ||
        now - stamp >= 24 * 60 * 60 * 1000) {
      clickCounter = 0;
      localStorage.setItem(K.clickCounter, "0");
      localStorage.setItem(K.clickStamp, String(now));
    } else {
      clickCounter = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    }
  }
  refreshLikeBudget();

  function triggerClick(el) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  // 读某一楼层已有的点赞数。linux.do 上是：
  //   <button class="discourse-reactions-counter only-like">
  //     ...<span class="reactions-counter">102</span>
  // 拿不到数字时返回 0（宁可不点赞，也不要误点）。
  function postLikeCount(postEl) {
    var counter = postEl.querySelector(".discourse-reactions-counter");
    if (!counter) return 0;
    var span = counter.querySelector(".reactions-counter");
    var raw = span ? span.textContent : counter.textContent;
    var n = parseInt(String(raw || "").replace(/[^0-9]/g, ""), 10);
    return isFinite(n) ? n : 0;
  }

  // 判断这一层自己赞过没有。赞过时图标会换成实心红心（d-icon-d-liked）。
  function alreadyLiked(postEl) {
    if (postEl.querySelector(".d-icon-d-liked")) return true;
    var use = postEl.querySelector(".btn-toggle-reaction-like use");
    if (use) {
      var href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      if (href.indexOf("fas-heart") >= 0) return true;
    }
    var btn = postEl.querySelector(".btn-toggle-reaction-like");
    return !!(btn && btn.getAttribute("aria-pressed") === "true");
  }

  // 找这一层真正能点的那个 button。外层 .discourse-reactions-reaction-button 是 div，
  // 在它上面派发 click 不一定能触发 Discourse 的处理逻辑，所以必须点到内层 button。
  function likeButtonOf(postEl) {
    return postEl.querySelector(".discourse-reactions-reaction-button button") ||
      postEl.querySelector(".btn-toggle-reaction-like");
  }

  function likeLimitReached() {
    refreshLikeBudget();
    if (clickCounter < getConfig().dailyLikeCap) return false;
    // 点赞额度是运行限制，不应覆盖用户的开关意图；否则用户点击「自动点赞」
    // 后会立刻又被关掉，看起来像按钮失效。保留开关为「开」，只暂停实际点赞。
    setStatus("已达过去 24 小时点赞上限，调整设置或额度恢复后继续");
    renderLikeButton();
    return true;
  }

  var likePassBusyUntil = 0;   // 上一批点赞还没点完时，不要再排新的一批

  // 扫描当前已加载的楼层，找出「赞数超过阈值、且自己还没赞过」的，按赞数从高到低点赞。
  // 每次只处理一批，间隔随机，避免短时间大量写请求。
  function autoLike() {
    if (!isAutoLikeEnabled()) return 0;
    if (likeLimitReached()) return 0;
    if (Date.now() < likePassBusyUntil) return 0;

    var minCount = getConfig().likeMinCount;
    var posts = document.querySelectorAll(".topic-post");
    var candidates = [];

    for (var i = 0; i < posts.length; i++) {
      var el = posts[i];
      if (el.getAttribute("data-liked-by-me") === "1") continue;
      var count = postLikeCount(el);
      if (count <= minCount) continue;
      if (alreadyLiked(el)) {
        el.setAttribute("data-liked-by-me", "1"); // 记一笔，后面几轮就不用重复判断
        continue;
      }
      var btn = likeButtonOf(el);
      if (!btn) continue;
      candidates.push({ el: el, btn: btn, count: count });
    }

    candidates.sort(function (a, b) { return b.count - a.count; });
    candidates = candidates.slice(0, Math.min(LIKE_PER_PASS, getConfig().dailyLikeCap - clickCounter));
    if (!candidates.length) return 0;

    var t = timing();
    // 排好队就先把这些楼层标记掉，避免下一轮扫描重复排队点两次
    for (var m = 0; m < candidates.length; m++) {
      candidates[m].el.setAttribute("data-liked-by-me", "1");
    }
    likePassBusyUntil = Date.now() + (candidates.length - 1) * t.likeGapMax + 1500;

    for (var j = 0; j < candidates.length; j++) {
      (function (item, index) {
        setTimeout(function () {
          if (likeLimitReached()) {
            item.el.removeAttribute("data-liked-by-me");
            return;
          }
          triggerClick(item.btn);
          clickCounter++;
          localStorage.setItem(K.clickCounter, String(clickCounter));
          bumpLike();
          renderOverlay();
          if (clickCounter >= getConfig().dailyLikeCap) likeLimitReached();
        }, index * randInt(t.likeGapMin, t.likeGapMax));
      })(candidates[j], j);
    }
    return candidates.length;
  }

  // ============================================================
  // 13. 启动
  // ============================================================
  function boot() {
    pruneTabs();
    migrateToPerTab();
    startHeartbeat();

    shell = document.createElement("div");
    shell.className = "ar-shell";
    var controls = document.createElement("div");
    controls.className = "ar-controls";
    details = document.createElement("div");
    details.className = "ar-details";
    details.style.display = "none";
    overlay.setAttribute("role", "button");
    overlay.setAttribute("tabindex", "0");
    overlay.setAttribute("aria-expanded", "false");
    overlay.setAttribute("aria-label", "自动阅读摘要，点击展开或收起设置");
    controls.appendChild(button);
    controls.appendChild(toggleAutoLikeButton);
    controls.appendChild(settingsButton);
    details.appendChild(controls);
    details.appendChild(panel);
    shell.appendChild(overlay);
    shell.appendChild(details);
    document.body.appendChild(shell);
    restoreCardPosition();
    setupCardDragging();
    renderLikeButton();
    renderPanel();
    renderOverlay();

    if (readFlag()) {
      setStatus(TXT.running);
      schedule(1500);
      if (isAutoLikeEnabled()) autoLike();
    } else {
      setStatus(TXT.idle);
    }

    // 万一这是「复制出来的标签页」，探测到之后换号；正常刷新不会有任何变化
    settleTabOwnership().then(function (duplicated) {
      if (duplicated) splitFromDuplicateTab();
    });

    // 供排查问题使用
    window.AutoReadInternals = {
      version: "2.3.5",
      get tabId() { return TAB_ID; },
      get nonce() { return TAB_NONCE; },
      channel: tabChannel,
      settleTabOwnership: settleTabOwnership,
      splitFromDuplicateTab: splitFromDuplicateTab,
      tabState: tabState,
      setTabState: setTabState,
      liveTabs: liveTabs,
      othersRunning: othersRunning,
      heartbeat: heartbeat,
      migrateToPerTab: migrateToPerTab,
      isAutoLikeEnabled: isAutoLikeEnabled,
      setAutoLikeEnabled: setAutoLikeEnabled,
      cycle: cycle,
      cycleOnce: cycleOnce,
      currentTopicId: currentTopicId,
      goToTopic: goToTopic,
      openNextTopic: openNextTopic,
      fetchTopics: fetchTopics,
      atBottom: atBottom,
      topicReady: topicReady,
      markTopicRead: markTopicRead,
      getReadCount: getReadCount,
      getFloorCount: getFloorCount,
      markFloorsRead: markFloorsRead,
      floorKeysOf: floorKeysOf,
      floorsReadNow: floorsReadNow,
      renderReadButton: renderReadButton,
      getConfig: getConfig,
      setConfig: setConfig,
      timing: timing,
      dwellRange: dwellRange,
      stats: function () { return stats; },
      setStatus: setStatus,
      stopReading: stopReading,
      autoLike: autoLike,
      postLikeCount: postLikeCount,
      alreadyLiked: alreadyLiked,
      likeButtonOf: likeButtonOf,
      getLikeClickCount: function () { return clickCounter; },
      setLikeClickCount: function (n) {
        clickCounter = Math.max(0, Math.floor(Number(n) || 0));
        localStorage.setItem(K.clickCounter, String(clickCounter));
        localStorage.setItem(K.clickStamp, String(Date.now()));
      },
      resetLikeBudget: function () {
        clickCounter = 0;
        localStorage.setItem(K.clickCounter, "0");
        localStorage.setItem(K.clickStamp, String(Date.now()));
      },
      set readFlag(v) { setTabState({ on: !!v }); },
      get readFlag() { return readFlag(); },
    };
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

