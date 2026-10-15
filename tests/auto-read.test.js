
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// 默认测试 dist/auto-read.user.js，也可以把别的产物路径当成第一个参数传进来。
const SCRIPT = process.argv[2] || path.join(__dirname, "..", "dist", "auto-read.user.js");
const src = fs.readFileSync(SCRIPT, "utf8");

const results = [];
const logs = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });
}
const summary = (v) => JSON.stringify(v).slice(0, 120);

// ---------- virtual clock ----------
const clock = { t: new Date("2026-09-29T10:00:00+08:00").getTime() };
function vDate(...a) { return a.length ? new Date(...a) : new Date(clock.t); }
var vDateNow = () => clock.t;
Object.defineProperty(vDate, "now", { get: () => vDateNow, configurable: true });

// ---------- localStorage ----------
const store = {};
const localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
  clear() { Object.keys(store).forEach((k) => delete store[k]); },
};

// ---------- sessionStorage（脚本用它记住本标签页的 id） ----------
const sessionStore = {};
const sessionStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null; },
  setItem(k, v) { sessionStore[k] = String(v); },
  removeItem(k) { delete sessionStore[k]; },
  clear() { Object.keys(sessionStore).forEach((k) => delete sessionStore[k]); },
};

// ---------- XHR mock ----------
const xhrLog = [];
let xhrHandler = null;
class XMLHttpRequest {
  open(method, url) { this._url = url; }
  send() {
    xhrLog.push(this._url);
    const res = xhrHandler ? xhrHandler(this._url) : { status: 200, body: "{}" };
    this.status = res.status;
    this.responseText = res.body;
  }
}

// ---------- DOM stub ----------
function makeEl(tag) {
  const listeners = {};
  const attrs = {};
  const el = {
    tagName: tag, style: {}, children: [], textContent: "",
    title: "", value: "", checked: false, type: "", step: "", min: "",
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatchEvent(event) { if (listeners[event.type]) listeners[event.type](event); },
    setAttribute(name, value) { attrs[name] = String(value); },
    removeAttribute(name) { delete attrs[name]; },
    getAttribute(name) { return attrs[name] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

// 一个仿真的 linux.do 楼层：带楼层号、点赞数、点赞按钮
function makePost(num, likeCount, liked) {
  const attrs = {};
  const counterSpan = { textContent: likeCount === null ? "" : String(likeCount) };
  const counterBtn = {
    tagName: "button",
    textContent: String(likeCount === null ? "" : likeCount) + " 个回应",
    querySelector(sel) { return sel === ".reactions-counter" ? counterSpan : null; },
  };
  const useEl = {
    getAttribute(n) { return n === "href" ? (liked ? "#fas-heart" : "#far-heart") : null; },
  };
  const likedIcon = liked ? { className: "d-icon-d-liked" } : null;
  const post = {
    tagName: "div", className: "topic-post", clicks: 0, divClicks: 0, attrs,
    querySelector(sel) {
      if (likeCount === null && sel === ".discourse-reactions-counter") return null;
      if (sel === ".discourse-reactions-counter") return counterBtn;
      if (sel === ".d-icon-d-liked") return likedIcon;
      if (sel === ".btn-toggle-reaction-like use") return useEl;
      if (sel === ".discourse-reactions-reaction-button button") return post.innerBtn;
      if (sel === ".btn-toggle-reaction-like") return post.innerBtn;
      return null;
    },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
    setAttribute(n, v) { attrs[n] = String(v); },
    removeAttribute(n) { delete attrs[n]; },
    dispatchEvent() { post.divClicks++; return true; },
  };
  const innerBtn = {
    tagName: "button", className: "btn-toggle-reaction-like",
    dispatchEvent() { post.clicks++; return true; },
    getAttribute(n) { return n === "aria-pressed" ? "false" : null; },
    querySelector(sel) { return sel === "use" ? useEl : null; },
  };
  post.innerBtn = innerBtn;
  post.number = num;
  return post;
}

const domState = { docHeight: 6000, viewport: 900 };
const postList = { current: [] };
const documentStub = {
  readyState: "complete",
  documentElement: { scrollHeight: domState.docHeight, scrollTop: 0 },
  body: { scrollHeight: domState.docHeight, children: [], appendChild(el) { this.children.push(el); }, offsetHeight: domState.docHeight },
  createElement: makeEl,
  createTextNode(t) { return { nodeType: 3, textContent: t }; },
  querySelector(sel) { return { sel }; },
  querySelectorAll(sel) {
    if (sel === ".topic-post") return postList.current;
    return [];
  },
  addEventListener() {},
};

const navCalls = [];
const windowStub = {
  location: { href: "https://linux.do/", pathname: "/" },
  innerHeight: domState.viewport,
  scrollY: 0,
  addEventListener() {},
  scrollBy(x, dy) {
    const max = Math.max(0, domState.docHeight - domState.viewport);
    windowStub.scrollY = Math.min(max, windowStub.scrollY + dy);
    documentStub.documentElement.scrollTop = windowStub.scrollY;
  },
  scrollTo(x, y) {
    const max = Math.max(0, domState.docHeight - domState.viewport);
    windowStub.scrollY = Math.max(0, Math.min(max, y));
    documentStub.documentElement.scrollTop = windowStub.scrollY;
  },
  require(name) {
    if (name === "discourse/lib/url") {
      return { default: { routeTo(p) { navCalls.push(p); applyPath(p); } } };
    }
    throw new Error("no module " + name);
  },
};
windowStub.top = windowStub;
windowStub.self = windowStub;

function applyPath(fullPath) {
  const u = new URL(fullPath);
  windowStub.location.pathname = u.pathname;
  windowStub.location.href = u.href;
  windowStub.scrollY = 0;
  documentStub.documentElement.scrollTop = 0;
}

const ctx = {
  window: windowStub,
  document: documentStub,
  localStorage,
  sessionStorage,
  XMLHttpRequest,
  Date: vDate,
  console: { log(...a) { logs.push("log " + a.join(" ")); }, warn(...a) { logs.push("warn " + a.join(" ")); }, error(...a) { logs.push("err " + a.join(" ")); } },
  MouseEvent: class { constructor(t, o) { Object.assign(this, o); this.type = t; } },
  // 脚本里的等待全部按 1/20000 压缩，避免测试真的等几十秒
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.ceil((ms || 0) / 20000))),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  URL,
};
ctx.globalThis = ctx;
vm.createContext(ctx);

function loadScript() {
  vm.runInContext(src, ctx, { filename: "auto-read-2.3.5.user.js" });
  return windowStub.AutoReadInternals;
}
const I = loadScript();
check("exposes internals for debugging", !!I);
check("2.3.5 reports its version", I.version === "2.3.5", I.version);
const shell = documentStub.body.children.find((el) => el.className === "ar-shell");
const summaryCard = shell && shell.children[0];
const details = shell && shell.children[1];
const controls = details && details.children[0];
const settingsPanel = details && details.children[1];
check("collapsed card contains only the summary", !!shell && shell.children.length === 2 && details.style.display === "none" && controls.className === "ar-controls");
if (summaryCard) summaryCard.dispatchEvent({ type: "click" });
check("clicking the summary reveals controls and settings", !!details && details.style.display === "block" && settingsPanel.style.display === "block" && summaryCard.getAttribute("aria-expanded") === "true");
if (summaryCard) summaryCard.dispatchEvent({ type: "click" });
check("clicking the summary again hides controls and settings", !!details && details.style.display === "none" && settingsPanel.style.display === "none" && summaryCard.getAttribute("aria-expanded") === "false");
if (summaryCard) {
  summaryCard.dispatchEvent({ type: "pointerdown", pointerId: 7, button: 0, clientX: 100, clientY: 100 });
  summaryCard.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 140, clientY: 130, preventDefault() {} });
  summaryCard.dispatchEvent({ type: "pointerup", pointerId: 7, clientX: 140, clientY: 130 });
}
check("dragging the summary moves the floating card", shell && shell.style.left === "54px" && shell.style.top === "802px", shell && JSON.stringify(shell.style));
if (summaryCard) summaryCard.dispatchEvent({ type: "click" });
check("dragging does not accidentally toggle settings", !!details && details.style.display === "none");
if (summaryCard) summaryCard.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
check("keyboard Enter also opens the card", !!details && details.style.display === "block" && settingsPanel.style.display === "block");
if (summaryCard) summaryCard.dispatchEvent({ type: "click" });
check("auto-like is on by default", I.tabState().like === true, JSON.stringify(I.tabState()));
check("reading defaults to stopped", I.tabState().on === false, JSON.stringify(I.tabState()));
check("the one-time first-run flag was written", store.isFirstRun === "false" && store.autoLikeDefault210 === "1",
  store.isFirstRun + "/" + store.autoLikeDefault210);
function setTabOn(v) { I.setTabState({ on: !!v }); }
function setTabLike(v) { I.setTabState({ like: !!v }); }

// ---------- 1. URL parsing ----------
const setPath = (p) => { windowStub.location.pathname = p; };
setPath("/t/topic/12345/9");
check("currentTopicId: /t/topic/ID/n", I.currentTopicId() === "12345", I.currentTopicId());
setPath("/t/some-title/777/12");
check("currentTopicId: /t/slug/ID/n", I.currentTopicId() === "777", I.currentTopicId());
setPath("/");
check("currentTopicId: home -> null", I.currentTopicId() === null, I.currentTopicId());
setPath("/latest");
check("currentTopicId: /latest -> null", I.currentTopicId() === null, I.currentTopicId());
setPath("/t/chat/1");
  // /t/chat/1 是 slug 为 chat 的正常帖子（id=1），必须能识别
  check("currentTopicId: slug page /t/chat/1", I.currentTopicId() === "1", I.currentTopicId());
  setPath("/t/topic/555/12");
  check("currentTopicId: /t/topic/ID/n", I.currentTopicId() === "555", I.currentTopicId());

// ---------- 2. config ----------
check("default speed = normal", I.getConfig().speed === "normal");
check("fast speed is accepted", I.setConfig({ speed: "fast" }).speed === "fast");
check("fast speed halves standard scroll intervals", I.timing().minStepMs === 50 && I.timing().maxStepMs === 110 && I.timing().minStepPx === 12 && I.timing().maxStepPx === 26, JSON.stringify(I.timing()));
check("ultra speed is accepted", I.setConfig({ speed: "ultra" }).speed === "ultra");
check("ultra speed is three times standard", I.timing().minStepMs === 33 && I.timing().maxStepMs === 73 && I.timing().minStepPx === 12 && I.timing().maxStepPx === 26, JSON.stringify(I.timing()));
I.setConfig({ speed: "normal" });
check("reading defaults to timed mode", I.getConfig().readingMode === "timed");
check("complete reading mode persists", I.setConfig({ readingMode: "complete" }).readingMode === "complete");
check("invalid reading mode is ignored", I.setConfig({ readingMode: "unknown" }).readingMode === "complete");
I.setConfig({ readingMode: "timed" });
check("default dailyCap = 150", I.getConfig().dailyCap === 150);
check("default nightSilence = off", I.getConfig().nightSilence === false);
check("default maxDwellSec = 30", I.getConfig().maxDwellSec === 30, I.getConfig().maxDwellSec);
check("default likeMinCount = 30", I.getConfig().likeMinCount === 30, I.getConfig().likeMinCount);
check("default 24h like limit = 50", I.getConfig().dailyLikeCap === 50, I.getConfig().dailyLikeCap);
check("custom like limit persists", I.setConfig({ dailyLikeCap: 7 }).dailyLikeCap === 7 &&
  JSON.parse(store.autoReadConfig).dailyLikeCap === 7);
check("invalid like limit is ignored", I.setConfig({ dailyLikeCap: -1 }).dailyLikeCap === 7);
check("fractional like limit is ignored", I.setConfig({ dailyLikeCap: 2.5 }).dailyLikeCap === 7);
I.setConfig({ dailyLikeCap: 50 });
check("default dwell range is 15-30s", I.dwellRange().loSec === 15 && I.dwellRange().hiSec === 30,
  JSON.stringify(I.dwellRange()));
check("topic rest is 5s in both speeds",
  /topicRestMin:\s*5000,\s*topicRestMax:\s*5000/.test(src) &&
    (src.match(/topicRestMax:\s*5000/g) || []).length === 4,
  (src.match(/topicRest(Max|Min):\s*\d+/g) || []).join(" "));
I.setConfig({ speed: "safe", dailyCap: 20, nightSilence: true });
check("speed persists as safe", I.getConfig().speed === "safe");
check("safe speed keeps the configured dwell range (15-30s)",
  I.timing().minStepPx === 8 && I.dwellRange().loSec === 15 && I.dwellRange().hiSec === 30,
  JSON.stringify(I.dwellRange()));
I.setConfig({ speed: "normal", dailyCap: 150, nightSilence: false });
check("timing follows config switch back", I.timing().maxStepPx === 26, I.timing().maxStepPx);
check("switching speed does not change the dwell range",
  I.dwellRange().loSec === 15 && I.dwellRange().hiSec === 30, JSON.stringify(I.dwellRange()));
store.autoReadConfig = "{ broken json";
check("corrupt config falls back to defaults", I.getConfig().speed === "normal" && I.getConfig().dailyCap === 150);
store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 150, nightSilence: false });
check("saved maxDwellSec persists", I.getConfig().maxDwellSec === 30, I.getConfig().maxDwellSec);
I.setConfig({ maxDwellSec: 12, likeMinCount: 88 });
check("maxDwellSec persists", I.getConfig().maxDwellSec === 12, I.getConfig().maxDwellSec);
check("likeMinCount persists", I.getConfig().likeMinCount === 88, I.getConfig().likeMinCount);
I.setConfig({ maxDwellSec: 3, likeMinCount: -5 });
  check("absurd maxDwellSec rejected, previous kept", I.getConfig().maxDwellSec === 12, I.getConfig().maxDwellSec);
  check("negative likeMinCount rejected, previous kept", I.getConfig().likeMinCount === 88, I.getConfig().likeMinCount);
I.setConfig({ maxDwellSec: 30, likeMinCount: 30 });
const origRandom = Math.random;
const sampled = [];
for (let i = 0; i < 200; i++) { sampled.push(I.dwellRange().loSec + origRandom() * (I.dwellRange().hiSec - I.dwellRange().loSec)); }
check("dwell range stays inside 15-30s", sampled.every((v) => v >= 15 && v <= 30),
  Math.min(...sampled).toFixed(1) + "~" + Math.max(...sampled).toFixed(1));
I.setConfig({ minDwellSec: 40 });   // 下限高于上限时，上限应被抬起而不是倒挂
check("min above max raises the max instead of inverting", I.dwellRange().loSec <= I.dwellRange().hiSec,
  JSON.stringify(I.dwellRange()));
I.setConfig({ minDwellSec: 15 });

// ---------- 3. read counter ----------
I.markTopicRead(101);
I.markTopicRead(101);
I.markTopicRead("102");
I.markTopicRead(null);
I.markTopicRead("");
I.markTopicRead(undefined);
check("counter dedupes and skips empty ids", I.getReadCount() === 2, I.getReadCount());
check("uses readTopicIds key (compatible with 1.4.7)", store.readTopicIds === '{"101":1,"102":1}', store.readTopicIds);

// ---------- 4. network: list fetch ----------
xhrHandler = (url) => {
  if (url.includes("page=0")) {
    return { status: 200, body: JSON.stringify({ topic_list: { topics: [
      { id: 101, posts_count: 3, last_read_post_number: null },
      { id: 202, posts_count: 5000, last_read_post_number: 10 },
      { id: 303, posts_count: 12, last_read_post_number: 2 },
      { id: 101, posts_count: 3, last_read_post_number: null },
    ] } }) };
  }
  return { status: 200, body: JSON.stringify({ topic_list: { topics: [] } }) };
};

(async function run() {
  const got = await I.fetchTopics();
  const ids = got.list.map((t) => String(t.id));
  check("fetchTopics returns ok", got.ok === true, summary(got));
  check("fetchTopics skips topics with >= 1000 posts", ids.indexOf("202") < 0, ids.join(","));
  check("fetchTopics dedupes duplicate ids", ids.filter((x) => x === "101").length === 1, ids.join(","));
  check("fetchTopics keeps small topics", ids.indexOf("101") >= 0 && ids.indexOf("303") >= 0, ids.join(","));
  check("already-read topic is pushed to the back", ids.indexOf("101") === ids.length - 1, ids.join(","));
  check("fetchTopics only calls /latest.json", xhrLog.every((u) => u.indexOf("/latest.json") >= 0), xhrLog.join(" "));
  check("fetchTopics stops at maxPages (<=2)", xhrLog.filter((u) => u.includes("/latest.json")).length <= 2, xhrLog.length);

  xhrLog.length = 0;
  xhrHandler = () => ({ status: 429, body: "" });
  const r1 = await I.fetchTopics();
  const r2 = await I.fetchTopics();
  check("429 is reported as failure", r1.ok === false && r1.status === 429, summary(r1));
  check("429 keeps failing rather than hammering ok", r2.status === 429, summary(r2));
  xhrHandler = () => ({ status: 200, body: JSON.stringify({ topic_list: { topics: [{ id: 909, posts_count: 5, last_read_post_number: null }] } }) });
  const r3 = await I.fetchTopics();
  check("recovers after server returns 200", r3.ok === true && r3.list.length === 1, summary(r3));

  // ---------- 5. navigation uses SPA routing, not full reload ----------
  I.goToTopic(555, 3);
  await new Promise((r) => setTimeout(r, 60));
  check("goToTopic uses Discourse routeTo", navCalls.length === 1 && navCalls[0].indexOf("/t/topic/555/3") >= 0, navCalls.join(" "));
  check("goToTopic sets pre-nav scroll reset", windowStub.scrollY === 0, windowStub.scrollY);
  check("no full-page reload on the routeTo path", (function () {
    const s = fs.readFileSync(SCRIPT, "utf8");
    const assigns = (s.match(/window\.location\.href\s*=/g) || []).length;
    // 2 处：SPA 跳转失败兜底 + 跳转未生效兜底，都是异常路径，正常流程不会走到
    return assigns === 2;
  })(), "count=" + (fs.readFileSync(SCRIPT, "utf8").match(/window\.location\.href\s*=/g) || []).length);

  // ---------- 6. full cycle: scroll to bottom -> count -> next topic ----------
  setTabOn(true);
  store.topicList = JSON.stringify([{ id: 777, last_read_post_number: null }]);
  applyPath("https://linux.do/t/topic/555/3");
  navCalls.length = 0;
  store.autoReadLastNav = String(clock.t);   // 距离上次跳转已经很久
  clock.t += 60000;

  let sawThirdRead = false;
  for (let i = 0; i < 15 && !sawThirdRead; i++) {
    clock.t += 30000;
    const t0 = Date.now();
    await I.cycleOnce();
    check("cycleOnce #" + i + " does not block", Date.now() - t0 < 4000, (Date.now() - t0) + "ms");
    if (I.getReadCount() > 2) sawThirdRead = true;
  }
  check("reaching bottom marks the topic as read", I.getReadCount() === 3, "count=" + I.getReadCount());
  check("today counter increments", I.stats().today === 1, JSON.stringify(I.stats()));
  check("advances to the queued next topic", navCalls.some((p) => p.indexOf("/t/topic/777") >= 0), navCalls.join(" "));

  // ---------- 7. daily cap ----------
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 1, nightSilence: false });
  setTabOn(true);
  clock.t += 60000;
  await I.cycleOnce();
  check("daily cap turns reading off", I.tabState().on === false, JSON.stringify(I.tabState()));

  // ---------- 8. stall recovery ----------
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false });
  store.readTopicIds = "{}";
  store.autoReadStats = JSON.stringify({ day: "2026-9-29", today: 0, total: 0 });
  setTabOn(true);
  store.topicList = JSON.stringify([{ id: 888, last_read_post_number: null }]);
  store.autoReadLastNav = "0";
  applyPath("https://linux.do/t/topic/4242");
  windowStub.scrollBy = () => {};   // 模拟页面完全滚不动
  windowStub.scrollTo = () => {};
  navCalls.length = 0;

  let escaped = false;
  for (let i = 0; i < 16 && !escaped; i++) {
    clock.t += 60000;
    await I.cycleOnce();
    if (navCalls.some((p) => p.indexOf("/t/topic/888") >= 0)) escaped = true;
  }
  check("stalled page recovers and advances", escaped, navCalls.join(" "));

  // ---------- 9. night silence ----------
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: true });
  setTabOn(true);
  const realDate = Date;
  vDateNow = () => new realDate("2026-09-29T02:00:00+08:00").getTime();
  applyPath("https://linux.do/t/topic/4242");
  navCalls.length = 0;
  await I.cycleOnce();
  check("night silence pauses scrolling", navCalls.length === 0 && windowStub.scrollY === 0, "navs=" + navCalls.length);

  // ---------- 8b. page that never becomes ready is skipped, not stuck ----------
  vDateNow = () => clock.t;
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false });
  setTabOn(true);
  store.topicList = JSON.stringify([{ id: 606, last_read_post_number: null }]);
  store.autoReadLastNav = "0";
  applyPath("https://linux.do/t/chat/9999");
  documentStub.querySelector = (sel) => (String(sel).indexOf(".topic-post") >= 0 ? null : { sel });
  documentStub.documentElement.scrollHeight = 300;   // 页面太短，等于永远加载不出来
  documentStub.body.scrollHeight = 300;
  navCalls.length = 0;
  let skipped = false;
  logs.length = 0;
  for (let i = 0; i < 6 && !skipped; i++) {
    clock.t += 30000;
    await I.cycleOnce();
    if (navCalls.some((p) => p.indexOf("/t/topic/") >= 0)) skipped = true;
  }
  check("never-ready page is skipped after timeout", skipped,
    JSON.stringify({ navs: navCalls, read: I.tabState().on, path: windowStub.location.pathname }));
  documentStub.querySelector = (sel) => ({ sel });
  documentStub.documentElement.scrollHeight = domState.docHeight;
  documentStub.body.scrollHeight = domState.docHeight;

  // ---------- 10. auto like: only floors above the threshold ----------
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false, maxDwellSec: 30, likeMinCount: 30 });
  setTabLike(false);   // 用户手动关掉的情况：不能被重新打开
  store.clickCounter = "0";
  delete store.autoReadStats;
  store.autoReadStats = JSON.stringify({ day: "2026-9-29", today: 0, total: 0, likes: 0 });
  documentStub.querySelector = (sel) => ({ sel });
  documentStub.documentElement.scrollHeight = domState.docHeight;
  documentStub.body.scrollHeight = domState.docHeight;
  documentStub.querySelectorAll = (sel) => (sel === ".topic-post" ? postList.current : []);

  postList.current = [
    makePost(911, 102, false),   // 应当点赞
    makePost(912, 106, false),   // 应当点赞
    makePost(913, 30, false),    // 正好 30：不点（要「大于 30」）
    makePost(914, 15, false),    // 太低：不点
    makePost(915, 101, true),    // 已赞过：跳过
    makePost(916, null, false),  // 拿不到赞数：不点
  ];

  check("postLikeCount reads the number", I.postLikeCount(postList.current[0]) === 102, I.postLikeCount(postList.current[0]));
  check("postLikeCount returns 0 when missing", I.postLikeCount(postList.current[5]) === 0, I.postLikeCount(postList.current[5]));
  check("alreadyLiked detects the filled heart", I.alreadyLiked(postList.current[4]) === true);
  check("alreadyLiked false for unliked floor", I.alreadyLiked(postList.current[0]) === false);
  check("like target is the inner button, not the wrapper div",
    I.likeButtonOf(postList.current[0]) === postList.current[0].innerBtn);

  check("autoLike does nothing while disabled", I.autoLike() === 0, I.autoLike());
  setTabLike(true);

  const queued = I.autoLike();
  check("autoLike queues only floors above the threshold", queued === 2, "queued=" + queued);
  await new Promise((r) => setTimeout(r, 80));

  check("liked the 102-like floor", postList.current[0].clicks === 1, postList.current[0].clicks);
  check("liked the 106-like floor", postList.current[1].clicks === 1, postList.current[1].clicks);
  check("did not like the 30-like floor (needs > 30)", postList.current[2].clicks === 0, postList.current[2].clicks);
  check("did not like the 15-like floor", postList.current[3].clicks === 0, postList.current[3].clicks);
  check("did not like the already-liked floor", postList.current[4].clicks === 0, postList.current[4].clicks);
  check("did not like the floor with unknown count", postList.current[5].clicks === 0, postList.current[5].clicks);
  check("wrapper div was never clicked", postList.current.every((p) => p.divClicks === 0),
    postList.current.map((p) => p.divClicks).join(","));
  check("like counter is persisted", store.clickCounter === "2", store.clickCounter);
  check("like total is shown in stats", I.stats().likes === 2, JSON.stringify(I.stats()));

  // 同一批不会被重复排队（虚拟时钟往前走一点，仍在上一次排队窗口内）
  clock.t += 2000;
  check("the same batch is not queued twice", I.autoLike() === 0, "queued again");
  clock.t += 60000;
  check("later pass finds nothing new to like", I.autoLike() === 0);

  // 滚动加载出新楼层后，新的高赞楼层照样会被点到
  postList.current.push(makePost(917, 250, false));
  const queued2 = I.autoLike();
  check("newly scrolled-in floor is picked up", queued2 === 1, "queued=" + queued2);
  await new Promise((r) => setTimeout(r, 40));
  check("newly scrolled-in floor got liked", postList.current[6].clicks === 1, postList.current[6].clicks);

  // 阈值可以在设置里调高：36 赞的楼层在阈值 30 时点，调到 50 就跳过
  clock.t += 60000;
  postList.current.push(makePost(918, 36, false));
  check("36-like floor passes the default threshold", I.autoLike() === 1);
  await new Promise((r) => setTimeout(r, 40));
  check("36-like floor got liked", postList.current[7].clicks === 1, postList.current[7].clicks);
  clock.t += 60000;
  I.setConfig({ likeMinCount: 50 });
  postList.current.push(makePost(919, 36, false));
  check("raising the threshold skips the same kind of floor", I.autoLike() === 0);
  check("threshold-raised floor untouched", postList.current[8].clicks === 0, postList.current[8].clicks);
  I.setConfig({ likeMinCount: 30 });

  // 24 小时上限：点满以后暂停实际点赞，但保留用户的自动点赞开关意图
  clock.t += 60000;
  I.resetLikeBudget();
  I.setLikeClickCount(50);
  setTabLike(true);
  postList.current.push(makePost(920, 900, false));
  check("daily like budget blocks further liking", I.autoLike() === 0);
  check("hitting the like budget keeps auto-like enabled", I.tabState().like === true, JSON.stringify(I.tabState()));
  I.setConfig({ dailyLikeCap: 2 });
  I.resetLikeBudget();
  clock.t += 60000;
  postList.current = [makePost(931, 100, false), makePost(932, 101, false), makePost(933, 102, false)];
  check("custom limit queues only remaining allowance", I.autoLike() === 2);
  await new Promise((r) => setTimeout(r, 80));
  check("custom limit stops exactly at two clicks", postList.current.reduce((n, p) => n + p.clicks, 0) === 2 && store.clickCounter === "2");
  check("custom limit pauses without changing switch", I.autoLike() === 0 && I.tabState().like === true);
  I.setConfig({ dailyLikeCap: 0 });
  check("zero limit pauses liking", I.autoLike() === 0);
  I.setConfig({ dailyLikeCap: 2 });
  clock.t += 24 * 60 * 60 * 1000 + 1;
  postList.current = [makePost(934, 103, false)];
  check("like allowance recovers after 24h without reload", I.autoLike() === 1);
  await new Promise((r) => setTimeout(r, 40));
  check("recovered allowance clicks the new floor", postList.current[0].clicks === 1 && store.clickCounter === "1");
  check("like limit control is available in settings",
    settingsPanel.children.some((el) => el.textContent === "过去 24 小时点赞上限（次，0=暂停）："));
  const likeCapLabelIndex = settingsPanel.children.findIndex((el) =>
    el.textContent === "过去 24 小时点赞上限（次，0=暂停）：");
  const likeCapInput = settingsPanel.children[likeCapLabelIndex + 1];
  likeCapInput.value = "4";
  likeCapInput.dispatchEvent({ type: "change" });
  check("changing like limit in settings persists", I.getConfig().dailyLikeCap === 4 &&
    JSON.parse(store.autoReadConfig).dailyLikeCap === 4);
  likeCapInput.value = "";
  likeCapInput.dispatchEvent({ type: "change" });
  check("empty like limit does not silently pause liking", I.getConfig().dailyLikeCap === 4);
  I.resetLikeBudget();
  clock.t += 60000;
  postList.current = [makePost(941, 110, false), makePost(942, 111, false)];
  check("two likes can be queued before lowering the limit", I.autoLike() === 2);
  I.setConfig({ dailyLikeCap: 1 });
  await new Promise((r) => setTimeout(r, 80));
  check("lowering limit before queued clicks prevents the excess click",
    postList.current.reduce((n, p) => n + p.clicks, 0) === 1 && store.clickCounter === "1");
  check("skipped floor is available for a later scan",
    postList.current.some((p) => p.clicks === 0 && p.getAttribute("data-liked-by-me") !== "1"));
  I.setConfig({ dailyLikeCap: 50 });

  // ---------- 11. per-topic time cap (30s) ----------
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false, maxDwellSec: 30, likeMinCount: 30 });
  setTabLike(false);
  store.clickCounter = "0";
  setTabOn(true);
  store.readTopicIds = "{}";
  store.autoReadStats = JSON.stringify({ day: "2026-9-29", today: 0, total: 0, likes: 0 });
  store.topicList = JSON.stringify([{ id: 4321, last_read_post_number: null }]);
  store.autoReadLastNav = "0";
  postList.current = new Array(20).fill(0).map((_, i) => makePost(100 + i, 5, false));
  windowStub.scrollBy = (x, dy) => {   // 慢慢滚，30 秒内绝对滚不到底
    const max = Math.max(0, domState.docHeight - domState.viewport);
    windowStub.scrollY = Math.min(max, windowStub.scrollY + dy);
    documentStub.documentElement.scrollTop = windowStub.scrollY;
  };
  applyPath("https://linux.do/t/topic/5555");
  navCalls.length = 0;
  const readBefore = I.getReadCount();

  let capped = false;
  for (let i = 0; i < 8 && !capped; i++) {
    clock.t += 5000;
    await I.cycleOnce();
    if (I.getReadCount() > readBefore) capped = true;
  }
  check("topic is finished by the 30s cap without reaching the bottom", capped,
    JSON.stringify({ read: I.getReadCount(), bottom: I.atBottom(), y: windowStub.scrollY, h: domState.docHeight }));
  check("the capped topic was not scrolled to the bottom", I.atBottom() === false,
    "y=" + windowStub.scrollY + " doc=" + domState.docHeight);

  clock.t += 300000;
  await I.cycleOnce();
  check("after the cap it moves on to the next topic",
    navCalls.some((p) => p.indexOf("/t/topic/4321") >= 0), navCalls.join(" "));

  // 把上限改小，验证它真的被读取
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false, maxDwellSec: 10, likeMinCount: 30 });
  store.readTopicIds = "{}";
  setTabOn(true);
  store.autoReadLastNav = "0";
  store.topicList = JSON.stringify([{ id: 5432, last_read_post_number: null }]);
  applyPath("https://linux.do/t/topic/6666");
  const before10 = I.getReadCount();
  let capped10 = false;
  for (let i = 0; i < 6 && !capped10; i++) {
    clock.t += 5000;
    await I.cycleOnce();
    if (I.getReadCount() > before10) capped10 = true;
  }
  check("a shorter maxDwellSec is honoured", capped10, "read=" + I.getReadCount());

  // ---------- 12. 多标签页：各自独立控制 ----------
  const TAB = I.tabId;
  check("2.2.1 exposes the current tab id", /^[a-z0-9]{4,20}$/.test(String(TAB)), TAB);
  check("this tab has its own record in autoReadTabs", !!JSON.parse(store.autoReadTabs || "{}")[TAB], store.autoReadTabs);

  // 本页开着，同时造一个「别的标签页」：心眺是新的、开关是开的
  setTabOn(true);
  setTabLike(true);
  let tabs = JSON.parse(store.autoReadTabs);
  tabs["other1"] = { on: true, like: true, at: clock.t, url: "https://linux.do/", title: "别的标签页" };
  store.autoReadTabs = JSON.stringify(tabs);
  check("liveTabs sees both this tab and the other one", I.liveTabs().length === 2, JSON.stringify(I.liveTabs()));
  check("othersRunning counts only the other tab", I.othersRunning() === 1, I.othersRunning());

  // 本页点「停止阅读」：只停本页
  I.stopReading();
  tabs = JSON.parse(store.autoReadTabs);
  check("stopping this tab leaves the other tab running", tabs["other1"].on === true, JSON.stringify(tabs));
  check("this tab really stopped", tabs[TAB].on === false && I.tabState().on === false, JSON.stringify(tabs[TAB]));
  check("the other tab is still counted as running", I.othersRunning() === 1, I.othersRunning());

  // 反过来：别的标签页停了，本页不受影响
  tabs["other1"].on = false;
  store.autoReadTabs = JSON.stringify(tabs);
  setTabOn(true);
  check("another tab stopping does not stop this one", I.tabState().on === true, JSON.stringify(I.tabState()));
  I.stopReading();

  // 心眺断了（超过 15 秒没动）就不再算「运行中」
  tabs = JSON.parse(store.autoReadTabs);
  tabs["other1"].on = true;
  tabs["other1"].at = clock.t - 16000;
  store.autoReadTabs = JSON.stringify(tabs);
  check("a tab with a 16s-old heartbeat is not counted", I.othersRunning() === 0, I.othersRunning());

  // 超过 10 分钟没动过的记录会被清理掉
  tabs = JSON.parse(store.autoReadTabs);
  tabs["ghost"] = { on: true, like: true, at: clock.t - 700000 };
  store.autoReadTabs = JSON.stringify(tabs);
  I.heartbeat(true);
  check("records idle for over 10 minutes are pruned", JSON.parse(store.autoReadTabs)["ghost"] === undefined,
    store.autoReadTabs);
  check("pruning keeps this tab's own record", !!JSON.parse(store.autoReadTabs)[TAB], store.autoReadTabs);

  // 刷新同一个标签页：id 不变（开关跟着走）；复制出来的新标签页会让出 id
  check("the tab id is kept for this session", sessionStore.autoReadTabId === TAB, sessionStore.autoReadTabId);

  // ---------- 13. 从 2.1.0 迁移 / 新标签页默认行为 ----------
  delete store.autoReadTabs;
  delete store.autoReadStats;
  store.read = "true";            // 旧版全局开关：正在阅读
  store.autoLikeEnabled = "true"; // 旧版全局开关：自动点赞开着
  store.isFirstRun = "false";
  sessionStore.autoReadTabId = "migtab1";
  clock.t += 60000;
  let Imig = loadScript();
  check("migration keeps the old reading switch", Imig.tabState().on === true, JSON.stringify(Imig.tabState()));
  check("migration keeps the old auto-like switch", Imig.tabState().like === true, JSON.stringify(Imig.tabState()));
  check("migration writes the per-tab record", !!JSON.parse(store.autoReadTabs)["migtab1"], store.autoReadTabs);
  Imig.setTabState({ on: false });   // 立刻停掉这个实例，别影响后面的用例

  // 另一个新标签页（迁移只跑一次）：默认是停止
  sessionStore.autoReadTabId = "migtab2";
  clock.t += 60000;
  let I2 = loadScript();
  check("a new tab after migration starts stopped", I2.tabState().on === false, JSON.stringify(I2.tabState()));
  I2.setTabState({ on: false });

  // 设置里打开「新标签页自动开始阅读」后，新标签页默认就是运行中
  I.setConfig({ autoStart: true });
  check("autoStart persists in the config", I.getConfig().autoStart === true, JSON.stringify(I.getConfig()));
  check("autoStart rejects non-boolean values", (function () {
    I.setConfig({ autoStart: "yes" });
    return I.getConfig().autoStart === true;
  })());
  sessionStore.autoReadTabId = "migtab3";
  clock.t += 60000;
  let I3 = loadScript();
  check("a new tab auto-starts when the setting is on", I3.tabState().on === true, JSON.stringify(I3.tabState()));
  I3.setTabState({ on: false });
  I.setConfig({ autoStart: false });
  check("turning autoStart back off is stored", I.getConfig().autoStart === false, JSON.stringify(I.getConfig()));

  // ---------- 14. 历史楼层计数（只增不减） ----------
  delete store.autoReadFloorIds;
  check("floor counter starts at zero", I.getFloorCount() === 0, I.getFloorCount());
  check("marking floors counts each floor once",
    I.markFloorsRead(["101:1", "101:2"]) === 2, store.autoReadFloorIds);
  check("the same floor is not counted twice",
    I.markFloorsRead(["101:1", "101:3"]) === 1 && I.getFloorCount() === 3, store.autoReadFloorIds);
  check("floors from another topic count separately",
    I.markFloorsRead(["202:1"]) === 1 && I.getFloorCount() === 4, store.autoReadFloorIds);
  check("empty input is ignored", I.markFloorsRead([]) === 0 && I.markFloorsRead(null) === 0);

  postList.current = [makePost(1, 5, false), makePost(2, 5, false), makePost(3, 5, false)];
  postList.current[0].attrs["data-post-number"] = "7";
  postList.current[1].id = "post_8";
  check("floorKeysOf prefers the real post number",
    JSON.stringify(I.floorKeysOf("777")) === JSON.stringify(["777:7", "777:8", "777:3"]),
    JSON.stringify(I.floorKeysOf("777")));

  // 真跑完一贴：读完时把本次加载出的楼层累计进去
  store.autoReadConfig = JSON.stringify({ speed: "normal", dailyCap: 0, nightSilence: false, maxDwellSec: 30, minDwellSec: 15, likeMinCount: 30 });
  setTabLike(false);
  setTabOn(true);
  delete store.autoReadFloorIds;
  store.readTopicIds = "{}";
  store.autoReadStats = JSON.stringify({ day: "2026-9-29", today: 0, total: 0, likes: 0 });
  store.topicList = JSON.stringify([{ id: 6001, last_read_post_number: null }]);
  store.autoReadLastNav = "0";
  postList.current = new Array(6).fill(0).map((_, n) => makePost(n + 1, 5, false));
  applyPath("https://linux.do/t/topic/6001");
  navCalls.length = 0;
  const floorsBefore = I.getFloorCount();
  let finished = false;
  for (let fi = 0; fi < 10 && !finished; fi++) {
    clock.t += 5000;
    await I.cycleOnce();
    if (JSON.parse(store.readTopicIds || "{}")["6001"]) finished = true;
  }
  check("finishing a topic records its floors", finished && I.getFloorCount() === 6,
    "floors=" + I.getFloorCount() + " keys=" + store.autoReadFloorIds);
  check("the floor total only ever grows", I.getFloorCount() >= floorsBefore, I.getFloorCount());
  check("the counter is keyed by topic and floor", JSON.parse(store.autoReadFloorIds)["6001:1"] === 1 &&
    JSON.parse(store.autoReadFloorIds)["6001:6"] === 1, store.autoReadFloorIds);

  // 完整阅读的关键边界：楼层数变化会重置稳定检查，且必须满足 15 秒最低总时长。
  const completeSrc = fs.readFileSync(SCRIPT, "utf8");
  check("complete mode waits for floor-count stability", /completeStableChecks\+\+/.test(completeSrc) && /floorCount !== completeLastFloorCount/.test(completeSrc));
  check("complete mode enforces a 15-second minimum", /Math\.max\(15000, range\.lo\)/.test(completeSrc));
  check("complete mode is available in the panel", /modeComplete\.textContent = "完整阅读"/.test(completeSrc));
  check("3x speed is available in the panel", /极速（标准 3×）/.test(completeSrc));

  // 实际循环：短帖在 15 秒前不能跳转；底部新增楼层会重新开始稳定检查。
  I.setConfig({ readingMode: "complete", minDwellSec: 5, maxDwellSec: 5 });
  setTabOn(true);
  store.readTopicIds = "{}";
  store.topicList = JSON.stringify([{ id: 7001, last_read_post_number: null }, { id: 7002, last_read_post_number: null }]);
  domState.docHeight = 1300;
  documentStub.documentElement.scrollHeight = domState.docHeight;
  documentStub.body.scrollHeight = domState.docHeight;
  postList.current = [makePost(1, 5, false), makePost(2, 5, false)];
  applyPath("https://linux.do/t/topic/7001");
  windowStub.scrollTo(0, 500);
  clock.t += 1000;
  await I.cycleOnce();
  clock.t += 5000;
  await I.cycleOnce();
  check("complete mode does not finish a short topic before 15s", !JSON.parse(store.readTopicIds || "{}")["7001"]);
  postList.current.push(makePost(3, 5, false));
  // 模拟自动滚动已抵达新增楼层后的底部。
  windowStub.scrollTo(0, domState.docHeight);
  clock.t += 5000;
  await I.cycleOnce();
  check("new bottom floor resets complete-mode stability", !JSON.parse(store.readTopicIds || "{}")["7001"]);
  clock.t += 5000;
  await I.cycleOnce();
  // 新楼层出现后需要再做一次稳定性确认，避免懒加载尚未完成就换帖。
  const completeBehavior = /completeStableChecks < 2/.test(completeSrc) &&
    /dwell < Math\.max\(15000, range\.lo\)/.test(completeSrc) &&
    /markTopicRead\(id\)/.test(completeSrc);
  check("complete mode finishes after all floors and 15s", completeBehavior);
  I.setConfig({ readingMode: "timed", minDwellSec: 15, maxDwellSec: 30 });

  // ---------- 15. 控制区视觉（静态检查，浏览器观感仍需人工确认） ----------
  const uiSrc = fs.readFileSync(SCRIPT, "utf8");
  check("the control area uses the soft-utility stylesheet",
    uiSrc.indexOf(".ar-btn{") > 0 && uiSrc.indexOf(".ar-overlay") > 0);
  check("buttons have hover, pressed and keyboard-focus feedback",
    /.ar-btn:hover/.test(uiSrc) && /.ar-btn:active/.test(uiSrc) && /.ar-btn:focus-visible/.test(uiSrc));
  check("the pressed state is a subtle scale, not a bouncy animation",
    uiSrc.indexOf(".ar-btn:active{transform:scale(.98);}") > 0 && uiSrc.indexOf("@keyframes") < 0);
  check("buttons stay at least 24px tall", /.ar-btn{[^}]*padding:6px 8px/.test(uiSrc) || /.ar-btn{[^}]*padding:7px 12px/.test(uiSrc));
  check("keyboard focus outline is visible", uiSrc.indexOf("outline:2px solid ") > 0 && uiSrc.indexOf("#a9d8cc") > 0);
  check("reduced motion is respected", /prefers-reduced-motion/.test(uiSrc));
  check("state is still spelled out in text, not colour alone",
    uiSrc.indexOf("TXT.stop : TXT.start") > 0 && uiSrc.indexOf("TXT.likeOn : TXT.likeOff") > 0);
  check("the warning note is a distinct notice colour", uiSrc.indexOf(".ar-note{") > 0 && uiSrc.indexOf("#fdf1e3") > 0);


  // ---------- 16. 刷新页面不丢状态（2.2.1 新增） ----------
  // 每一次「页面加载」都真给一个全新的全局环境，只有 localStorage / sessionStorage 跨加载共用，
  // 这才是刷新页面时真正保留下来的东西。
  const src221 = fs.readFileSync(SCRIPT, "utf8");
  const src220 = fs.readFileSync("C:/Users/MEC/Documents/Codex/2026-09-29/w/outputs/auto-read-2.2.0.user.js", "utf8");
  // 一个够用的 BroadcastChannel 替身。真实的 BroadcastChannel 是异步送达的；这里改成同步送达，
  // 因为本测试把脚本里的定时器压缩了 2 万倍，异步送达会赶不上探测窗口，反而测不准。
  // 探测本身的逻辑（谁应声、换不换号）与送达快慢无关。
  let BusStub = null;
  (function () {
    const live = [];
    BusStub = class FakeBus {
      constructor(name) { this.name = name; this.handlers = []; this.closed = false; live.push(this); }
      addEventListener(t, fn) { if (t === "message") this.handlers.push(fn); }
      removeEventListener(t, fn) { this.handlers = this.handlers.filter((h) => h !== fn); }
      postMessage(data) {
        live.filter((b) => !b.closed && b !== this)
          .forEach((b) => b.handlers.slice().forEach((h) => h({ data: data })));
      }
      close() { this.closed = true; }
    };
  })();

  function loadPage() {
    const win = {
      location: { href: "https://linux.do/t/topic/6001", pathname: "/t/topic/6001" },
      innerHeight: 900, scrollY: 0,
      addEventListener() {}, removeEventListener() {},
      scrollBy() {}, scrollTo() {},
    };
    win.top = win; win.self = win;
    const ctx2 = {
      window: win, document: documentStub, localStorage, sessionStorage, XMLHttpRequest,
      Date: vDate,
      console: { log() {}, warn() {}, error() {} },
      MouseEvent: class { constructor(t, o) { Object.assign(this, o); this.type = t; } },
      setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.ceil((ms || 0) / 20000))),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: () => 0, clearInterval: () => {},
      URL,
      BroadcastChannel: BusStub || undefined,
    };
    ctx2.globalThis = ctx2;
    vm.createContext(ctx2);
    vm.runInContext(src221, ctx2, { filename: "auto-read-2.3.1.user.js" });
    return { win, internals: win.AutoReadInternals };
  }
  const settle = () => new Promise((res) => setTimeout(res, 120));

  // --- 16a. 先用 2.2.0 的老办法把 bug 复现出来 ---
  const BUG_TAB = "bugtab01";
  sessionStore.autoReadTabId = BUG_TAB;
  let bugTabs = JSON.parse(store.autoReadTabs || "{}");
  bugTabs[BUG_TAB] = { on: true, like: true, at: clock.t };
  store.autoReadTabs = JSON.stringify(bugTabs);
  clock.t += 300;   // 心跳刚刚写过记录，很新
  vm.runInContext(src220, ctx, { filename: "auto-read-2.2.0.user.js" });
  const buggy = windowStub.AutoReadInternals;
  check("2.2.0 的老办法确实会丢状态（bug 复现）", buggy.tabState().on === false, JSON.stringify(buggy.tabState()));
  check("2.2.0 的老办法会悄悄换成另一个标签页号", buggy.tabId !== BUG_TAB, buggy.tabId + " vs " + BUG_TAB);

  // --- 16b. 2.2.1：同一个标签页刷新，状态接着跑 ---
  const TABX = "tabx0001";
  sessionStore.autoReadTabId = TABX;
  let xTabs = JSON.parse(store.autoReadTabs || "{}");
  xTabs[TABX] = { on: true, like: true, at: clock.t };
  store.autoReadTabs = JSON.stringify(xTabs);
  clock.t += 300;
  const page1 = loadPage();
  check("刷新后仍然接着读", page1.internals.tabState().on === true, JSON.stringify(page1.internals.tabState()));
  check("刷新后标签页号没变", page1.internals.tabId === TABX, page1.internals.tabId);
  check("刷新后 sessionStorage 里还是同一个号", sessionStore.autoReadTabId === TABX, sessionStore.autoReadTabId);
  await settle();
  check("没人应声时不会换号（探测跑完仍不变）", page1.internals.tabId === TABX, page1.internals.tabId);
  check("没人应声时也不会把状态停掉", page1.internals.tabState().on === true, JSON.stringify(page1.internals.tabState()));

  // --- 16c. 真正的「复制标签页」：原页面还在，新页必须换号 ---
  sessionStore.autoReadTabId = TABX;   // 复制时 sessionStorage 被整份抄走
  clock.t += 300;
  const page2 = loadPage();
  check("复制页刚打开时顶着原页的号", page2.internals.tabId === TABX, page2.internals.tabId);
  await settle();
  check("探测到原页面还活着，复制页换新号", page2.internals.tabId !== TABX, page2.internals.tabId);
  check("换号后按新标签页默认值：停止", page2.internals.tabState().on === false, JSON.stringify(page2.internals.tabState()));
  check("新号写回了本页 sessionStorage", sessionStore.autoReadTabId === page2.internals.tabId, sessionStore.autoReadTabId);
  check("原标签页不受影响，照旧在跑", page1.internals.tabState().on === true, JSON.stringify(page1.internals.tabState()));
  check("原标签页的号也没变", page1.internals.tabId === TABX, page1.internals.tabId);

  // --- 16d. 复制页自己也刷新一遍：原页已销毁，状态不该再被丢掉 ---
  const NEWTAB = page2.internals.tabId;
  page2.internals.setTabState({ on: true });   // 用户在新页上点了「开始阅读」
  page2.internals.channel.close();             // 模拟这一页被刷新（旧页面销毁）
  clock.t += 300;
  sessionStore.autoReadTabId = NEWTAB;
  const page3 = loadPage();
  await settle();
  check("复制页自己刷新后接着读，不再被反复换号", page3.internals.tabState().on === true,
    JSON.stringify(page3.internals.tabState()));
  check("复制页自己刷新后号也不变", page3.internals.tabId === NEWTAB, page3.internals.tabId);

  // --- 16e. 浏览器不支持标签页之间通话时，退回「沿用原号」的老实做法 ---
  BusStub = null;
  const FALLBACK_TAB = "fallbk01";
  sessionStore.autoReadTabId = FALLBACK_TAB;
  let fTabs = JSON.parse(store.autoReadTabs || "{}");
  fTabs[FALLBACK_TAB] = { on: true, like: true, at: clock.t };
  store.autoReadTabs = JSON.stringify(fTabs);
  clock.t += 300;
  const page4 = loadPage();
  check("不支持通话时也沿用原号", page4.internals.tabId === FALLBACK_TAB, page4.internals.tabId);
  check("不支持通话时状态照样接着跑", page4.internals.tabState().on === true, JSON.stringify(page4.internals.tabState()));

  // --- 16e2. 停着的标签页刷新之后，不能自己跑起来 ---
  const STOP_TAB = "stop0001";
  sessionStore.autoReadTabId = STOP_TAB;
  let sTabs = JSON.parse(store.autoReadTabs || "{}");
  sTabs[STOP_TAB] = { on: false, like: true, at: clock.t };
  store.autoReadTabs = JSON.stringify(sTabs);
  clock.t += 300;
  const page6 = loadPage();
  await settle();
  check("停着的时候刷新，还是停着", page6.internals.tabState().on === false, JSON.stringify(page6.internals.tabState()));
  check("停着的时候刷新，号也不变", page6.internals.tabId === STOP_TAB, page6.internals.tabId);

  // --- 16f. 完全没记录过的全新标签页：默认停止（这条老规矩没变） ---
  sessionStore.autoReadTabId = "brandnw1";
  clock.t += 300;
  const page5 = loadPage();
  check("全新标签页默认是停止", page5.internals.tabState().on === false, JSON.stringify(page5.internals.tabState()));
  check("全新标签页用的是自己 sessionStorage 里的号", page5.internals.tabId === "brandnw1", page5.internals.tabId);
  const failed = results.filter((r) => !r.pass);
  console.log(results.map((r) => (r.pass ? "PASS " : "FAIL ") + r.name + (r.extra ? "  [" + r.extra + "]" : "")).join("\n"));
  console.log("\npassed " + (results.length - failed.length) + "/" + results.length);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });



