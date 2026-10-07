import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import pino from "pino";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
// 调用方密钥:GATEWAY_KEY 支持逗号分隔多个(给不同的人各发一个,谁的泄露了删谁的)
// 支持 "名字=密钥" 写法,日志里记录名字而不是密钥;不写名字的取密钥末 4 位当标记
function parseGatewayKeys(raw) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = item.match(/^([\w\-\u4e00-\u9fa5]{1,32})=([^=].*)$/);
      return m ? { name: m[1], key: m[2] } : { name: "…" + item.slice(-4), key: item };
    });
}
const GATEWAY_KEY_LIST = parseGatewayKeys(process.env.GATEWAY_KEY || "");
const GATEWAY_KEYS = GATEWAY_KEY_LIST.map((k) => k.key);
// 管理密钥:单独设置后,只有它能进配置页/读配置;不设置则沿用 GATEWAY_KEY(单人使用时的老行为)
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ---------- 加载配置 ----------
// 默认读 /app/config.json(老的部署方式:compose 里把 ./config.json 挂进来)。
// 也可以设置环境变量 CONFIG_PATH(如 /app/data/config.json)并挂载整个目录;
// 这时如果文件还不存在,会自动用镜像里自带的 config.example.json 生成一份,
// 直接贴 compose 启动后,到「配置」页面填 API Key 即可。
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  const example = path.join(__dirname, "config.example.json");
  if (process.env.CONFIG_PATH && fs.existsSync(example)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(example, CONFIG_PATH);
    console.log("未找到 " + CONFIG_PATH + ",已用示例配置生成,请到「配置」页面填写 API Key");
  } else {
    console.error("找不到 config.json,请复制 config.example.json 为 config.json 并填写你的 API Key");
    process.exit(1);
  }
}
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const providers = {};
for (const p of config.providers) providers[p.name] = p;

function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    for (const key in providers) delete providers[key];
    for (const p of config.providers) providers[p.name] = p;
    fileLogger.info("config reloaded");
    cleanupOldLogs(true); // 改了保留天数后立刻生效,不用等下一个整点
  } catch (e) {
    fileLogger.error({ err: e.message }, "reload config failed");
  }
}

// ---------- 渠道禁用状态(持久化到 state.json,重启不丢失) ----------
const STATE_PATH = path.join(path.dirname(CONFIG_PATH), "state.json"); // 与配置同目录(老部署下仍是 /app/state.json)
let state = { disabled: {} };
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch (e) {
    fileLogger?.error?.({ err: e.message }, "load state failed");
  }
  if (!state.disabled) state.disabled = {};
}
function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    fileLogger?.error?.({ err: e.message }, "save state failed");
  }
}
function channelKey(group, provider, model) {
  return `${group}::${provider}::${model || ""}`;
}
// 检查是否被禁用;如果已经过了禁用期,顺手自动解禁
function isDisabled(key) {
  const d = state.disabled[key];
  if (!d) return false;
  if (Date.now() >= new Date(d.until).getTime()) {
    delete state.disabled[key];
    saveState();
    return false;
  }
  return true;
}
function disableChannelUntil(key, untilISO, reason) {
  state.disabled[key] = { until: untilISO, reason, disabledAt: new Date().toISOString() };
  saveState();
  return untilISO;
}
function disableChannelForHours(key, hours, reason) {
  return disableChannelUntil(key, new Date(Date.now() + hours * 3600 * 1000).toISOString(), reason);
}
// 计算"下一个固定时间点"(比如每天凌晨1点),如果这个时间点今天已经过了就顺延到明天
function nextResetTime(resetHour) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(resetHour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}
// 决定某个渠道这次应该禁用到什么时候:优先渠道自己的覆盖设置,否则用全局策略
function computeAutoDisableUntil(channel) {
  const mode = channel.autoDisableMode || config.autoDisableMode || "hours";
  if (mode === "resetHour") {
    const resetHour = channel.autoDisableResetHour ?? config.autoDisableResetHour ?? 0;
    return nextResetTime(resetHour).toISOString();
  }
  const hours = channel.autoDisableHours ?? config.autoDisableHours ?? 24;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}
function enableChannel(key) {
  delete state.disabled[key];
  saveState();
}

// ---------- ntfy 通知 ----------
async function notify(message) {
  const url = config.notify?.url;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", body: message });
  } catch (e) {
    fileLogger?.error?.({ err: e.message }, "ntfy notify failed");
  }
}

// ---------- 日志(按天分文件,自动清理超过保留天数的旧文件) ----------
const LOGS_DIR = path.join(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayLogPath() {
  return path.join(LOGS_DIR, `app-${localDateStr()}.log`);
}

// 内存里的最近请求记录(首页 / 日志页的数据来源),放在清理函数前面声明,避免清理时访问到未初始化的变量
const RING_SIZE = 500; // 内存里保留最近 500 条,给 /dashboard 用
const ring = [];

function retentionCutoff(now = Date.now()) {
  const keepDays = Number(config.logRetentionDays);
  return now - (keepDays > 0 ? keepDays : 3) * 24 * 3600 * 1000;
}

let lastCleanup = 0;
// force=true 时忽略"一小时一次"的限制(启动时、保存配置后用)
function cleanupOldLogs(force = false) {
  const now = Date.now();
  if (force !== true && now - lastCleanup < 3600 * 1000) return; // 最多一小时清理一次,避免每条日志都扫目录
  lastCleanup = now;
  try {
    const cutoff = retentionCutoff(now);
    // 1) 磁盘文件:整天都早于保留期限的才删(当天文件里可能还有期限内的记录)
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(/^app-(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (!m) continue;
      const dayEnd = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
      if (dayEnd <= cutoff) {
        try {
          fs.unlinkSync(path.join(LOGS_DIR, f));
        } catch {
          /* 单个文件删不掉不影响其他文件继续清理 */
        }
      }
    }
    // 2) 内存记录:按时间剔除超过保留期限的(首页/日志页看到的就是这份,以前只按条数淘汰,旧记录会一直挂着)
    for (let i = ring.length - 1; i >= 0; i--) {
      const t = Date.parse(ring[i].time);
      if (t && t < cutoff) ring.splice(i, 1);
    }
  } catch {
    /* 清理失败不应该影响主流程 */
  }
}
setInterval(cleanupOldLogs, 3600 * 1000); // 就算长时间没请求,也定时兜底清理一次

function writeFileLog(level, payload) {
  try {
    const obj = typeof payload === "string" ? { msg: payload } : payload || {};
    const line = JSON.stringify({ level, time: new Date().toISOString(), ...obj }) + "\n";
    fs.appendFileSync(todayLogPath(), line);
    cleanupOldLogs();
  } catch {
    /* 写文件日志失败不应该影响主请求 */
  }
}
const fileLogger = {
  info: (payload) => writeFileLog("info", payload),
  error: (payload, msg) => {
    const obj = typeof payload === "object" && payload !== null ? { ...payload } : {};
    if (msg) obj.msg = msg;
    writeFileLog("error", obj);
  },
};

let consoleLogger;
try {
  consoleLogger = pino({ transport: { target: "pino-pretty" } });
} catch {
  consoleLogger = pino(); // 回退,避免没装 pino-pretty 时崩掉
}

function pushLog(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  fileLogger.info(entry);
  const tag = entry.error ? `ERROR: ${entry.error}` : "";
  consoleLogger.info(
    `${entry.status ?? "-"} ${entry.method} ${entry.path} -> ${entry.provider || "-"} (${entry.durationMs}ms) ${tag}`
  );
}

// 启动时从磁盘日志恢复最近的请求记录,这样重启/重建容器后面板不会变成空白
function restoreRecentLogs() {
  try {
    cleanupOldLogs(true); // 先按保留天数清一遍旧文件,否则旧文件里的记录会被恢复回内存
    const cutoff = retentionCutoff();
    const files = fs.readdirSync(LOGS_DIR).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    const entries = [];
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(LOGS_DIR, f), "utf-8").split("\n")) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.method && obj.path && obj.time && Date.parse(obj.time) >= cutoff) entries.push(obj); // 只要保留期内的请求记录,跳过"config reloaded"这类系统日志
        } catch {
          /* 跳过损坏的行 */
        }
      }
    }
    ring.push(...entries.slice(-RING_SIZE));
    if (entries.length) consoleLogger.info(`已从日志文件恢复 ${Math.min(entries.length, RING_SIZE)} 条请求记录`);
  } catch {
    /* 恢复失败不影响启动 */
  }
}

function redact(str, keys) {
  if (!str) return str;
  let out = str;
  for (const k of keys) {
    if (k) out = out.split(k).join("***REDACTED***");
  }
  return out;
}

loadState();
restoreRecentLogs();

// ---------- 清理已删除模型的数据 ----------
// 配置里已经没有的渠道 / 分组 / provider,它们留在日志里的记录会一直显示在首页,这里统一清掉
function entryAlive(e, cfg) {
  if (e.group) {
    const chs = cfg.modelGroups && cfg.modelGroups[e.group];
    if (!Array.isArray(chs)) return false; // 整个分组都没了
    return chs.some((c) => c.provider === e.provider && (!c.model || !e.model || c.model === e.model));
  }
  // 直连 / 前缀路由的请求没有分组,只看 provider 还在不在
  return !e.provider || (cfg.providers || []).some((p) => p.name === e.provider);
}
function channelAlive(key, cfg) {
  const parts = key.split("::"); // 分组::provider::模型
  if (parts.length !== 3) return true; // 格式不认识就不动
  const chs = cfg.modelGroups && cfg.modelGroups[parts[0]];
  return Array.isArray(chs) && chs.some((c) => c.provider === parts[1] && (c.model || "") === parts[2]);
}
function purgeStale() {
  const out = { logs: 0, files: 0, disabled: 0 };
  const cfg = config;
  if (!Array.isArray(cfg.providers) || !cfg.providers.length) return out; // 配置是空的时候不动数据,防止误清空
  // 1) 内存里的最近记录(首页 / 日志页的数据来源)
  let ringDropped = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    if (!entryAlive(ring[i], cfg)) {
      ring.splice(i, 1);
      ringDropped++;
    }
  }
  // 2) 磁盘日志文件(否则重启后又从文件里恢复回来)
  let diskDropped = 0;
  try {
    for (const f of fs.readdirSync(LOGS_DIR)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const fp = path.join(LOGS_DIR, f);
      const keep = [];
      let dropped = 0;
      for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
        if (!line) continue;
        let o = null;
        try {
          o = JSON.parse(line);
        } catch {
          /* 损坏的行原样保留 */
        }
        if (o && o.method && o.path && o.time && !entryAlive(o, cfg)) dropped++;
        else keep.push(line); // 非请求记录(如 config reloaded)一律保留
      }
      if (dropped) {
        fs.writeFileSync(fp, keep.length ? keep.join("\n") + "\n" : "");
        diskDropped += dropped;
        out.files++;
      }
    }
  } catch {
    /* 清理失败不影响保存配置 */
  }
  out.logs = Math.max(ringDropped, diskDropped);
  // 3) 已删除渠道留下的"被禁用"记录
  for (const key of Object.keys(state.disabled)) {
    if (!channelAlive(key, cfg)) {
      delete state.disabled[key];
      out.disabled++;
    }
  }
  if (out.disabled) saveState();
  if (out.logs || out.disabled) fileLogger.info({ msg: "purged stale data", ...out });
  return out;
}

// ---------- app ----------
const app = express();
// 用 raw 而不是 json,这样任何 content-type(包括流式请求体)都能原样转发
app.use(express.raw({ type: "*/*", limit: "50mb" }));

app.get("/health", (req, res) => res.json({ ok: true, providers: Object.keys(providers) }));

app.get("/api/logs", checkAdminAuth, (req, res) => {
  res.json(ring.slice().reverse());
});

app.use("/dashboard", express.static(path.join(__dirname, "public", "dashboard")));
app.use("/admin", express.static(path.join(__dirname, "public", "admin")));
app.use("/", express.static(path.join(__dirname, "public", "home")));

// 管理接口鉴权:设置了 ADMIN_KEY 就只认它;否则沿用 GATEWAY_KEY;两个都没设就不做保护(仅建议内网使用)
function checkAdminAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  if (ADMIN_KEY) {
    if (auth === `Bearer ${ADMIN_KEY}`) return next();
  } else if (!GATEWAY_KEYS.length || GATEWAY_KEYS.some((k) => auth === `Bearer ${k}`)) {
    return next();
  }
  return res.status(401).json({ error: "unauthorized: 请在管理页填写正确的管理密钥" });
}

// 调用方鉴权:所有转发路径(统一入口、分组、路径前缀)都必须过这一关
function requireClientKey(req, res, next) {
  if (!GATEWAY_KEYS.length) return next();
  const auth = req.headers["authorization"] || "";
  const hit = GATEWAY_KEY_LIST.find((k) => auth === `Bearer ${k.key}`);
  if (hit) {
    req.clientName = hit.name;
    return next();
  }
  return res.status(401).json({ error: "invalid gateway key" });
}

app.post("/api/reload", checkAdminAuth, (req, res) => {
  reloadConfig();
  res.json({ ok: true, providers: Object.keys(providers) });
});

app.get("/api/config", checkAdminAuth, (req, res) => {
  res.json(config);
});

app.post("/api/config", checkAdminAuth, (req, res) => {
  try {
    const newConfig = JSON.parse(req.body.toString("utf-8"));
    if (!Array.isArray(newConfig.providers)) throw new Error("providers 必须是数组");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    reloadConfig();
    res.json({ ok: true, purged: purgeStale() }); // 删掉的渠道 / 模型,它们的历史数据一并清掉
  } catch (e) {
    res.status(400).json({ error: "配置格式有误: " + e.message });
  }
});

// 手动清理:把配置里已经不存在的渠道 / 模型留下的数据清掉
app.post("/api/purge-stale", checkAdminAuth, (req, res) => {
  res.json({ ok: true, purged: purgeStale() });
});

app.get("/api/state", checkAdminAuth, (req, res) => {
  res.json({ ...state, clients: GATEWAY_KEY_LIST.map((k) => k.name) });
});

app.post("/api/state/enable", checkAdminAuth, (req, res) => {
  try {
    const { key } = JSON.parse(req.body.toString("utf-8"));
    enableChannel(key);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/state/disable", checkAdminAuth, (req, res) => {
  try {
    const { group, provider, model, hours, resetHour } = JSON.parse(req.body.toString("utf-8"));
    const key = channelKey(group, provider, model);
    let until;
    if (resetHour !== undefined && resetHour !== null && resetHour !== "") {
      until = disableChannelUntil(key, nextResetTime(Number(resetHour)).toISOString(), "manual");
    } else {
      until = disableChannelForHours(key, hours ?? (config.autoDisableHours ?? 24), "manual");
    }
    res.json({ ok: true, until });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 手动测试 ntfy 是否能收到通知,不用真的等渠道报错来触发
// 支持传 url 覆盖,这样管理页可以测"输入框里还没保存的地址"
app.post("/api/notify-test", checkAdminAuth, async (req, res) => {
  let overrideUrl = null;
  try {
    const body = JSON.parse(req.body.toString("utf-8") || "{}");
    overrideUrl = body.url || null;
  } catch {
    /* 没传 body 也没关系,用已保存的配置 */
  }
  const url = overrideUrl || config.notify?.url;
  if (!url) {
    return res.status(400).json({ error: "还没配置 notify.url,先在下面填好地址再测试" });
  }
  try {
    const upstream = await fetch(url, {
      method: "POST",
      body: `🔔 这是一条来自 LLM 转发网关的测试通知\n发送时间: ${new Date().toISOString()}`,
    });
    const text = await upstream.text().catch(() => "");
    res.json({ ok: upstream.ok, upstreamStatus: upstream.status, upstreamBody: text.slice(0, 500) });
  } catch (e) {
    res.status(502).json({ error: "请求 ntfy 地址失败: " + e.message });
  }
});

// 手动测一个 provider/渠道是否真的可用:发一个最小的 chat completions 请求,看能不能通
app.post("/api/test-provider", checkAdminAuth, async (req, res) => {
  let providerName, model;
  try {
    const body = JSON.parse(req.body.toString("utf-8") || "{}");
    providerName = body.provider;
    model = body.model;
  } catch {
    return res.status(400).json({ error: "请求格式有误" });
  }
  const provider = providers[providerName];
  if (!provider) {
    return res.status(404).json({ error: "provider 不存在: " + providerName + "(先保存一次配置再测试)" });
  }
  if (!model) {
    return res.status(400).json({ error: "先填一个用来测试的 model 名字" });
  }

  const headers = { "content-type": "application/json" };
  const authHeader = provider.authHeader || "Authorization";
  const authPrefix = provider.authPrefix ?? "Bearer ";
  headers[authHeader] = `${authPrefix}${provider.apiKey}`;
  const downstreamPath = resolveDownstreamPath(provider, "/v1/chat/completions");
  const targetUrl = provider.baseUrl.replace(/\/$/, "") + downstreamPath;

  const start = Date.now();
  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
    });
    const durationMs = Date.now() - start;
    const text = await upstream.text().catch(() => "");
    res.json({
      ok: upstream.status < 400,
      status: upstream.status,
      durationMs,
      targetUrl,
      preview: redact(text.slice(0, 400), [provider.apiKey]),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message, targetUrl, durationMs: Date.now() - start });
  }
});

function pickProviderForModel(model) {
  if (!model || !config.modelRouting) return null;
  for (const rule of config.modelRouting) {
    if (model.startsWith(rule.prefix)) return rule.provider;
  }
  return null;
}

// 按权重做无放回随机排序:权重越高,排在前面(被选中)的概率越大
// 会先过滤掉当前被禁用(额度耗尽)的渠道;如果全部渠道都被禁用了,兜底还是全部再试一次
function weightedOrder(groupName, channels) {
  const enabled = channels.filter((c) => !isDisabled(channelKey(groupName, c.provider, c.model)));
  const pool = enabled.length ? enabled : channels;
  return pool
    .map((c) => ({ c, key: Math.random() ** (1 / Math.max(c.weight ?? 1, 0.0001)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.c);
}

// 走统一入口(/v1/...)或分组转发时,客户端请求路径固定是 /v1/xxx,
// 但有些上游(比如智谱 v4)真实端点不带这个 /v1 前缀。
// provider 上配置 pathPrefix 就能覆盖:比如 pathPrefix: "" 会把 /v1/chat/completions 改写成 /chat/completions。
function resolveDownstreamPath(provider, originalPath) {
  if (!provider || provider.pathPrefix === undefined || provider.pathPrefix === null) return originalPath;
  if (originalPath.startsWith("/v1")) return provider.pathPrefix + originalPath.slice(3);
  return originalPath;
}

const DEFAULT_RETRY_STATUS = [429, 500, 502, 503, 504];

// 方式一: 统一入口 /v1/xxx,按请求体里的 model 字段自动路由
app.all(/^\/v1\/.*/, requireClientKey, async (req, res) => {
  let bodyObj = null;
  const ct = req.headers["content-type"] || "";
  if (req.body && req.body.length && ct.includes("json")) {
    try {
      bodyObj = JSON.parse(req.body.toString("utf-8"));
    } catch {
      /* 忽略解析失败,走后面的 fallback */
    }
  }
  const model = bodyObj?.model;

  // 命中 modelGroups:说明这是个"虚拟模型名",要在多个免费渠道里选一个(权重+失败自动切换)
  if (model && config.modelGroups && config.modelGroups[model]) {
    return groupForward(model, bodyObj, req, res, req.originalUrl);
  }

  const providerName = pickProviderForModel(model) || req.query.provider || req.headers["x-provider"];
  if (!providerName) {
    return res.status(400).json({
      error:
        "无法确定使用哪个 provider。请在 config.json 里配置 modelRouting(按 model 前缀路由)或 modelGroups(多渠道分组),或者加 URL 参数 ?provider=xxx,或者请求头 X-Provider: xxx",
    });
  }
  await forward(providerName, req, res, resolveDownstreamPath(providers[providerName], req.originalUrl));
});

// 分组转发:一个虚拟模型名背后挂多个真实渠道,按权重随机 + 失败自动切换下一个
async function groupForward(groupName, bodyObj, req, res, downstreamPath) {
  const channels = config.modelGroups[groupName];
  const order = weightedOrder(groupName, channels);
  const retryStatuses = config.retryStatusCodes || DEFAULT_RETRY_STATUS;
  const autoDisableStatuses = config.autoDisableStatusCodes || [403, 429];
  let lastEntry = null;
  const reqId = Date.now() + "-" + Math.random().toString(36).slice(2, 8); // 同一次请求的多次渠道尝试共用

  for (let i = 0; i < order.length; i++) {
    const channel = order[i];
    const provider = providers[channel.provider];
    const start = Date.now();
    const entry = {
      id: start + "-" + Math.random().toString(36).slice(2, 8),
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      reqId,
      group: groupName,
      client: req.clientName,
      provider: channel.provider,
      attempt: i + 1,
      totalChannels: order.length,
    };

    if (!provider) {
      entry.status = 0;
      entry.error = "channel 里配置的 provider 不存在: " + channel.provider;
      entry.durationMs = Date.now() - start;
      pushLog(entry);
      lastEntry = entry;
      continue;
    }

    const newBody = { ...bodyObj, model: channel.model || bodyObj.model };
    const bodyBuf = Buffer.from(JSON.stringify(newBody));

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "content-length", "connection", "authorization", "content-type"].includes(k.toLowerCase()))
        continue;
      headers[k] = v;
    }
    headers["content-type"] = "application/json";
    const authHeader = provider.authHeader || "Authorization";
    const authPrefix = provider.authPrefix ?? "Bearer ";
    headers[authHeader] = `${authPrefix}${provider.apiKey}`;

    const targetUrl = provider.baseUrl.replace(/\/$/, "") + resolveDownstreamPath(provider, downstreamPath);
    entry.targetUrl = targetUrl;
    entry.actualModel = newBody.model;
    entry.model = newBody.model;

    try {
      const upstream = await fetch(targetUrl, { method: req.method, headers, body: bodyBuf });
      entry.status = upstream.status;

      if (autoDisableStatuses.includes(upstream.status)) {
        const key = channelKey(groupName, channel.provider, channel.model);
        const until = disableChannelUntil(key, computeAutoDisableUntil(channel), `HTTP ${upstream.status}`);
        entry.autoDisabledUntil = until;
        notify(
          `⚠️ 渠道已自动禁用\n分组: ${groupName}\n渠道: ${channel.provider} (${channel.model})\n原因: HTTP ${upstream.status}\n预计恢复: ${until}`
        );
      }

      const shouldRetryNext = retryStatuses.includes(upstream.status) && i < order.length - 1;
      if (shouldRetryNext) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        entry.responsePreview = redact(buf.toString("utf-8").slice(0, 500), [provider.apiKey]);
        entry.error = `渠道返回 ${upstream.status},自动切换下一个渠道`;
        entry.durationMs = Date.now() - start;
        pushLog(entry);
        lastEntry = entry;
        continue;
      }

      // 用这个渠道的响应作为最终结果返回给客户端
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
        res.setHeader(key, value);
      });

      if (upstream.status >= 400) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        entry.responsePreview = redact(buf.toString("utf-8").slice(0, 2000), [provider.apiKey]);
        entry.durationMs = Date.now() - start;
        pushLog(entry);
        return res.end(buf);
      }

      entry.durationMs = Date.now() - start;
      pushLog(entry);
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      entry.status = 0;
      entry.error = err.message;
      entry.durationMs = Date.now() - start;
      pushLog(entry);
      lastEntry = entry;
      continue;
    }
  }

  if (!res.headersSent) {
    notify(`🛑 分组 "${groupName}" 所有渠道都请求失败\n最后错误: ${JSON.stringify(lastEntry)}`);
    res.status(502).json({
      error: `分组 "${groupName}" 下所有渠道都请求失败`,
      lastError: lastEntry,
    });
  }
}

// 方式二: 路径前缀路由 /openai/v1/chat/completions -> 转发到 openai 配置的 baseUrl
app.all(/^\/([^/]+)\/(.*)/, requireClientKey, async (req, res) => {
  const providerName = req.params[0];
  const rest = "/" + req.params[1];
  if (!providers[providerName]) {
    return res
      .status(404)
      .json({ error: `未知 provider: ${providerName},可用: ${Object.keys(providers).join(", ")}` });
  }
  await forward(providerName, req, res, rest);
});

async function forward(providerName, req, res, downstreamPath) {
  const start = Date.now();
  const provider = providers[providerName];
  let requestedModel;
  try {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("json") && req.body && req.body.length) {
      requestedModel = JSON.parse(req.body.toString("utf-8")).model;
    }
  } catch {
    /* 不是 JSON 或解析失败,不影响转发,只是拿不到 model 名字用于统计 */
  }
  let entry = {
    id: start + "-" + Math.random().toString(36).slice(2, 8),
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    provider: providerName,
    model: requestedModel,
    client: req.clientName,
  };

  if (!provider) {
    entry.status = 404;
    entry.error = "unknown provider " + providerName;
    entry.durationMs = Date.now() - start;
    pushLog(entry);
    return res.status(404).json({ error: entry.error });
  }

  const targetUrl = provider.baseUrl.replace(/\/$/, "") + downstreamPath;
  entry.targetUrl = targetUrl;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection", "authorization"].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const authHeader = provider.authHeader || "Authorization";
  const authPrefix = provider.authPrefix ?? "Bearer ";
  headers[authHeader] = `${authPrefix}${provider.apiKey}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    entry.status = upstream.status;

    if (upstream.status >= 400) {
      // 出错时把响应体读出来存进日志,方便排查
      const buf = Buffer.from(await upstream.arrayBuffer());
      entry.responsePreview = redact(buf.toString("utf-8").slice(0, 2000), [provider.apiKey]);
      entry.requestPreview = redact(req.body ? req.body.toString("utf-8").slice(0, 1000) : "", [provider.apiKey]);
      entry.durationMs = Date.now() - start;
      pushLog(entry);
      return res.end(buf);
    }

    entry.durationMs = Date.now() - start;
    pushLog(entry);

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res); // 原样透传流式响应(SSE)
  } catch (err) {
    entry.status = 502;
    entry.error = err.message;
    entry.durationMs = Date.now() - start;
    pushLog(entry);
    if (!res.headersSent) res.status(502).json({ error: "upstream request failed", detail: err.message });
  }
}

app.listen(PORT, () => {
  consoleLogger.info(`LLM 转发网关已启动: http://localhost:${PORT}`);
  consoleLogger.info(`可用 providers: ${Object.keys(providers).join(", ")}`);
  consoleLogger.info(`日志面板: http://localhost:${PORT}/dashboard/`);
  consoleLogger.info(`配置管理: http://localhost:${PORT}/admin/`);
  if (!GATEWAY_KEYS.length) {
    consoleLogger.warn("未设置 GATEWAY_KEY:任何人都能直接调用转发接口和配置页,公网部署务必设置");
  } else if (!ADMIN_KEY) {
    consoleLogger.warn("未设置 ADMIN_KEY:拿到 GATEWAY_KEY 的人也能进配置页看到所有上游 API Key,多人使用建议单独设置 ADMIN_KEY");
  }
});
