// local-magpie —— 把 Magpie(marvis) 网关接进 dsh-go 手机界面
//
// 数据全部来自本机真实状态，不编：
//   · 网关 http://127.0.0.1:3425/v1/models  —— 通不通、有几个模型
//   · $MAGPIE_HOME/logins.json      —— 登录的是哪个号
//   · $MAGPIE_HOME/quotas.json      —— 剩余额度（magpie 每次请求后自己刷新）
//   · $MAGPIE_HOME/quota-history.json —— 额度采样历史（画曲线）
//   · ./state.json                          —— 上一次实测每个模型的结果（本插件自己写）
//
// 只读本地，不外发；点「测模型」才会真的向上游发一条最小请求。
//
// 快慢两条路，互不拖累：
//   快：额度只读本地小文件（几百字节），watchFile 一有变化就推，胶囊秒级跟手。
//   慢：网关连通性、模型列表走 HTTP，60 秒一次 —— 状态和它的时间戳来自同一次探测，
//       面板上「校验 11:36:42」就是这个状态产生的时刻，不会出现状态新、时间旧的错位。

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  watchFile,
  unwatchFile
} from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'local-magpie'

const MAGPIE_HOME = process.env.MAGPIE_HOME || ((process.env.HOME || '/root') + '/.config/magpie')
const GW = process.env.MAGPIE_GW_URL || 'http://127.0.0.1:3425'
const LOGINS = MAGPIE_HOME + '/logins.json'
const QUOTAS = MAGPIE_HOME + '/quotas.json'
/**
 * 面板与胶囊看哪个 provider —— 可在面板顶部切换。
 * prefix 用于匹配 quotas.json / quota-history.json 里的键，window 是该 provider 的额度窗口名。
 */
const PROVIDERS = {
  marvis: { prefix: 'marvis/', label: '腾讯', title: '腾讯 Marvis', window: '令牌用量', unit: 'tokens', home: 'marvis' },
  raccoon: { prefix: 'raccoon/', label: '小浣熊', title: '商汤小浣熊', window: 'Daily pool', unit: 'credits', home: 'raccoon' },
  workbuddy: { prefix: 'workbuddy/', label: 'WorkBuddy', title: 'WorkBuddy', window: 'Total credits', unit: 'credits', home: 'workbuddy' },
  'qoder-cn': { prefix: 'qoder-cn/', label: 'Qoder CN', title: 'Qoder CN', window: 'Total credits', unit: 'credits', home: 'qoder-cn' }
}
const PROVIDER_FILE = fileURLToPath(new URL('../active-provider.json', import.meta.url))
/** 记住面板里上次选的 provider，重启不丢；没存过就默认 WorkBuddy（用户主力额度就在这） */
let activeProvider = (() => {
  try {
    const v = JSON.parse(readFileSync(PROVIDER_FILE, 'utf8'))?.provider
    if (v && PROVIDERS[v]) return v
  } catch {
    /* 没存过就落到默认 */
  }
  return 'workbuddy'
})()
const provOf = () => PROVIDERS[activeProvider] ?? PROVIDERS.raccoon
/** 胶囊重推：切换 provider 后立刻刷新，不用等额度文件变化 */
const stripPushers = new Set()
const HISTORY = MAGPIE_HOME + '/quota-history.json'
const STATE = fileURLToPath(new URL('../state.json', import.meta.url))

/** 网关校验节奏：60 秒一次（额度是文件驱动，不跟这个走） */
const PROBE_TTL = 60_000
/** 网关探不通时只缓存 5 秒，好让它恢复后马上被看到 */
const PROBE_FAIL_TTL = 5_000

/** 显示名（截短，手机小屏），顺序 = 面板里的顺序。
 * 下方键名是本机账号下的模型 ID，仅示例，按你自己 /v1/models 返回改。 */
const LABELS = {
  'marvis/deepseek-v4-1-flash-261017': 'DS V4.1 Flash',
  'workbuddy/deepseek-v4-pro': 'DS V4 Pro · WB',
  'marvis/deepseek-v4-flash-ga-260731': 'DS V4 Flash',
  'marvis/hy3': '混元 Hy3',
  'marvis/claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'marvis/claude-opus-4-6': 'Claude Opus 4.6',
  'marvis/gpt-5.4-2026-03-05': 'GPT-5.4',
  'marvis/HY-Vision-2.0-instruct': 'HY Vision 2.0'
}

async function getJson(url, ms = 5000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return { checkedAt: '', models: {} }
  }
}

function writeState(next) {
  try {
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify(next))
  } catch {
    /* 写不进去不影响主流程 */
  }
}

/** 数字缩成手机小屏能看的：1.2亿 / 980万 / 8,300 */
function short(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`
  if (v >= 1e4) return `${Math.round(v / 1e4)}万`
  return v.toLocaleString('en-US')
}

/** 带一位小数的量：951.2万 —— 胶囊要能看出"掉了一点点"，取整会假装额度没变 */
function short1(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(Math.round(v))
}

/** 把「68.2M / ~200M」折成 token 数 */
function toTokens(num, unit) {
  const n = Number(String(num).replace(/,/g, ''))
  if (!Number.isFinite(n)) return 0
  const u = String(unit || '').toLowerCase()
  if (u === '亿') return n * 1e8
  if (u === 'm') return n * 1e6
  if (u === 'k') return n * 1e3
  return n
}

/** token 量按 M/亿 显示，跟网关里那档写法一致 */
function shortM(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (v >= 1e4) return `${Math.round(v / 1e4)}万`
  return String(Math.round(v))
}

/** resetsAt 时刻 → 本地 HH:MM */
function resetClock(s) {
  const t = Date.parse(String(s ?? '').replace(/(\.\d{3})\d+/, '$1'))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** provider windows 里「deepseek-v4.1-flash tokens (est.)」那档每日 token 额度 */
function deepseekDaily(windows) {
  const list = Array.isArray(windows) ? windows : []
  const w = list.find((x) => /deepseek/i.test(String(x?.name ?? '')) && Number(x?.limit) > 0)
  if (!w) return null
  const disp = String(w.display ?? '')
  let used = Number(w.amount ?? 0) || 0
  let limit = Number(w.limit ?? 0) || 0
  const m = /([\d.]+)\s*([KkMm亿]?)\s*\/\s*~?\s*([\d.]+)\s*([KkMm亿]?)/.exec(disp)
  if (m) {
    used = toTokens(m[1], m[2])
    const lim = toTokens(m[3], m[4])
    if (lim) limit = lim
  }
  if (!limit) return null
  return { used, limit, left: Math.max(0, limit - used), reset: String(w.resetsAt ?? '') }
}

/** 从窗口数组里挑「额外额度」(Extra credits)；没有就是 null —— 只有 workbuddy 有这一栏 */
function extraWindow(windows) {
  const list = Array.isArray(windows) ? windows : []
  const w = list.find((x) => /extra/i.test(String(x?.name ?? '')))
  if (!w) return null
  let used = Number(w.used ?? w.amount ?? 0)
  let limit = Number(w.limit ?? 0)
  // 优先按 display「已用 / 总量」算，跟主额度同口径
  const disp = String(w.display ?? '')
  const m = /^([\d,.]+)\s*\/\s*([\d,.]+)/.exec(disp)
  if (m) {
    used = Number(m[1].replace(/,/g, ''))
    const lim = Number(m[2].replace(/,/g, ''))
    if (lim) limit = lim
  }
  if (!limit) return null
  return { used, limit, left: Math.max(0, limit - used), display: disp }
}

/** 按名字挑额度主窗口（PROVIDERS[x].window），找不到退回第一个。
 *  workbuddy 主窗口是 'Total credits'（基础+额外合计池），不是 windows[0] 的基础 'Credits' —— 后者跑满会误报剩 0%。*/
function pickWindow(windows, name) {
  const list = Array.isArray(windows) ? windows : []
  if (name) {
    const hit = list.find((x) => String(x?.name ?? '') === String(name))
    if (hit) return hit
  }
  return list[0]
}

/** 时刻 → HH:MM:SS */
function clockOf(ms) {
  const d = new Date(Number(ms))
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 多久以前 → 8 秒前 / 3 分钟前；让"这数据有多新"一眼可读 */
function agoOf(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || !t) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${Math.round(s / 3600)} 小时前`
}

/**
 * 剩余额度 —— 读 magpie 自己缓存的腾讯令牌钱包。
 * magpie 每次成功请求后刷新这个文件（quota.windows[0] = {amount, limit, display}），
 * 所以这里不自己签名打上游，只读现成的，省一次请求也不会污染额度。
 */
function quotaOf() {
  try {
    const all = JSON.parse(readFileSync(QUOTAS, 'utf8'))
    const key = Object.keys(all).find((k) => k.startsWith(provOf().prefix))
    if (!key) return null
    const q = all[key]?.quota
    const w = pickWindow(q?.windows, provOf().window)
    if (!w) return null
    const used = Number(w.amount ?? 0)
    const limit = Number(w.limit ?? 0)
    if (!limit) return null
    return {
      used,
      limit,
      left: Math.max(0, limit - used),
      pct: Math.min(100, Math.round((used / limit) * 100)),
      leftPct: Math.max(0, ((limit - used) / limit) * 100),
      display: String(w.display ?? ''),
      readAt: String(q?.readAt ?? ''),
      user: String(q?.user ?? ''),
      plan: String(q?.plan ?? ''),
      unit: String(w?.unit ?? ''),
      extra: extraWindow(q?.windows),
      deepseek: deepseekDaily(q?.windows)
    }
  } catch {
    return null
  }
}

/**
 * 额度快读 —— 额度文件 mtime/size 没变就直接给上次结果，变了才重新解析。
 * 文件只有几百字节，一次 stat 是微秒级；这样 400ms 一次也几乎不耗电。
 * 解析失败（正好被写一半）时保留上一次成功的值，不闪「未知」。
 */
let quotaCache = { key: '', data: null }

function quotaFast() {
  try {
    const st = statSync(QUOTAS)
    const key = `${activeProvider}:${st.mtimeMs}:${st.size}`
    if (key === quotaCache.key) return quotaCache.data
    const data = quotaOf()
    if (data) {
      quotaCache = { key, data }
      return data
    }
  } catch {
    /* 文件读不到，落到下面走缓存 */
  }
  // 本 provider 在 quotas.json 里没有（社区 workbuddy 就不写）时，只认同 provider 的旧缓存，别拿别家的数冒充
  if (quotaCache.data && quotaCache.key.startsWith(`${activeProvider}:`)) return quotaCache.data
  return gwQuotaCache.prefix === provOf().prefix ? gwQuotaCache.data : null
}

/**
 * 额度回退 —— quotas.json 里没有这个 provider 时（社区插件的 workbuddy 就不写进去），
 * 直接问网关 /v1/magpie/quotas，同一份数据、含全部 provider。15 秒缓存，别每 400ms 打一次。
 */
let gwQuotaCache = { at: 0, prefix: '', data: null }

async function quotaFromGateway(p) {
  const now = Date.now()
  if (gwQuotaCache.prefix === p.prefix && now - gwQuotaCache.at < 4_000) return gwQuotaCache.data
  try {
    const rows = await getJson(`${GW}/v1/magpie/quotas`, 4000)
    const list = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : []
    const row = list.find((r) => String(r?.provider ?? '') === p.home)
    const w = pickWindow(row?.windows, p.window)
    if (!w) {
      gwQuotaCache = { at: now, prefix: p.prefix, data: null }
      return null
    }
    // 网关接口的 used 有时是百分比；display 才是「已用 / 总量」的人话，优先照它算。
    const disp = String(w.display ?? '')
    const dm = /^([\d,.]+)\s*\/\s*([\d,.]+)/.exec(disp.replace(/\s*(credits?|tokens?)\s*$/i, ''))
    // 「5,504,274 可用 / 共 10,000,000」这种是「剩 / 总量」，另算
    const dmLeft = /^([\d,.]+)\s*可用\s*\/\s*共?\s*([\d,.]+)/.exec(disp)
    let used = Number(w.used ?? 0)
    let limit = Number(w.limit ?? 0)
    if (dmLeft) {
      const leftN = Number(dmLeft[1].replace(/,/g, ''))
      const limN = Number(dmLeft[2].replace(/,/g, ''))
      if (limN) {
        used = Math.max(0, limN - leftN)
        limit = limN
      }
    } else if (dm && !/可用/.test(disp)) {
      used = Number(dm[1].replace(/,/g, ''))
      limit = Number(dm[2].replace(/,/g, ''))
    }
    if (!limit) {
      gwQuotaCache = { at: now, prefix: p.prefix, data: null }
      return null
    }
    const data = {
      used,
      limit,
      left: Math.max(0, limit - used),
      pct: Math.min(100, Math.round((used / limit) * 100)),
      leftPct: Math.max(0, ((limit - used) / limit) * 100),
      display: String(w.display ?? ''),
      readAt: String(row?.readAt ?? ''),
      user: String(row?.user ?? ''),
      plan: String(row?.plan ?? ''),
      unit: String(w?.unit ?? ''),
      extra: extraWindow(row?.windows),
      deepseek: deepseekDaily(row?.windows)
    }
    gwQuotaCache = { at: now, prefix: p.prefix, data }
    return data
  } catch {
    gwQuotaCache = { at: now, prefix: p.prefix, data: null }
    return null
  }
}

/** 额度采样历史（percent 剩余），给面板画曲线用 */function quotaHistory(limit = 30) {
  try {
    const all = JSON.parse(readFileSync(HISTORY, 'utf8'))
    const p = provOf()
    const key = Object.keys(all).find((k) => k.startsWith(p.prefix.replace(/\/$/, '|'))) ?? Object.keys(all)[0]
    const rows = all?.[key]?.[p.window] ?? []
    const tail = rows.slice(-limit)
    if (!tail.length) return null
    const categories = tail.map((r) => {
      const d = new Date(String(r.at))
      if (Number.isNaN(d.getTime())) return ''
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
    const values = tail.map((r) => {
      const v = Number(r.left)
      return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
    })
    return { categories, values }
  } catch {
    return null
  }
}

/** 拉起网关（start-gateway.sh 内部已 setsid，脱离引擎进程组） */
function bootGateway() {
  const script = process.env.START_GATEWAY_SH
  if (!script) return false
  try {
    spawn('sh', [script], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * 网关自愈：不通就拉起来。返回 true 表示这次真的动手拉了。
 *
 * 为什么放在插件里而不是外部 watchdog：App/引擎重启会杀掉 proot 里所有进程，
 * 外部 watchdog 自己也活不下来；插件跑在引擎里，引擎一启动 apply() 就会走到这里 ——
 * 这样网关和引擎同生同死，App 重启后自己回来。
 */
async function ensureGateway(probeMs = 2500) {
  try {
    const res = await fetch(`${GW}/v1/models`, { signal: AbortSignal.timeout(probeMs) })
    if (res.ok) return false
  } catch {
    /* 下面的 bootGateway 处理 */
  }
  return bootGateway()
}

/**
 * 网关连通性 —— 一次探测的结果是 {ok, at} 原子对。
 *
 * 这是「时间与数据同步」的根：面板上显示的 `校验 11:36:42` 和 `在线/掉线`
 * 取自同一个 gwCache 对象，永远是同一次请求的两个字段，不会各来自不同时刻。
 *
 * 节奏 60 秒：成功缓存 60 秒，失败只缓存 5 秒（网关恢复后立刻可见）。
 * 同时只允许一次探测在飞，后来的直接等同一个结果，不叠请求。
 */
let gwCache = { ok: null, at: 0 }
let gwInflight = null

async function probeGateway({ force = false, probeMs = 2500 } = {}) {
  const ttl = gwCache.ok === false ? PROBE_FAIL_TTL : PROBE_TTL
  if (!force && gwCache.ok !== null && Date.now() - gwCache.at < ttl) return gwCache
  if (gwInflight) return gwInflight
  gwInflight = (async () => {
    let ok = false
    try {
      const res = await fetch(`${GW}/v1/models`, { signal: AbortSignal.timeout(probeMs) })
      ok = res.ok
    } catch {
      ok = false
    }
    gwCache = { ok, at: Date.now() }
    return gwCache
  })()
  try {
    return await gwInflight
  } finally {
    gwInflight = null
  }
}

/**
 * 模型列表 —— 和网关连通性同一批缓存节奏（60 秒），失败 5 秒后重试。
 * 时间戳 at 永远保留（失败时也留），这样面板上不会出现「没有时刻的状态」。
 */
let modelCache = { at: 0, ids: [], ok: false }

async function listModels({ force = false } = {}) {
  const ttl = modelCache.ok ? PROBE_TTL : PROBE_FAIL_TTL
  if (!force && modelCache.at && Date.now() - modelCache.at < ttl) return modelCache
  try {
    const body = await getJson(`${GW}/v1/models`, 5000)
    const ids = (body?.data ?? []).map((m) => m.id).filter(Boolean)
    modelCache = { at: Date.now(), ids, ok: ids.length > 0 }
  } catch {
    modelCache = { at: Date.now(), ids: [], ok: false }
  }
  return modelCache
}

function accountOf() {
  try {
    const rows = JSON.parse(readFileSync(LOGINS, 'utf8'))
    if (!Array.isArray(rows)) return ''
    const p = provOf()
    const mine = rows.find((r) => String(r?.agent ?? '').includes(p.home))
    const row = mine ?? rows.find((r) => r?.on) ?? rows[0]
    return row?.user || ''
  } catch {
    return ''
  }
}

/**
 * 一次完整快照：网关 + 账号 + 模型 + 额度 + 上次实测。
 *
 * gatewayOk 与 gatewayAt 成对取自 gwCache（同一次探测）；
 * 网关正常时模型列表也用同一时刻那次结果，两者时间戳一致。
 */
async function snapshot({ forceGateway = false } = {}) {
  const state = readState()
  const gw = await probeGateway({ force: forceGateway })
  const gatewayOk = gw.ok === true
  const gwMs = Number(gw.at) || 0

  const m = await listModels({ force: forceGateway })

  const p = provOf()
  const mine = m.ids.filter((id) => id.startsWith(p.prefix))
  const order = Object.keys(LABELS)
  const sorted = [...mine].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const items = sorted.map((id) => {
    const mark = state.models?.[id]
    const trailing = mark === 'ok' ? '✓ 可用' : mark === 'no' ? '✗ 无权限' : '未测'
    return {
      title: LABELS[id] ?? id.slice(p.prefix.length),
      subtitle: id,
      trailing,
      tone: mark === 'ok' ? 'good' : mark === 'no' ? 'bad' : undefined
    }
  })

  const okCount = Object.values(state.models ?? {}).filter((v) => v === 'ok').length
  const q = quotaFast() ?? (await quotaFromGateway(p))
  const hist = quotaHistory()

  return {
    gatewayOk,
    gatewayText: gatewayOk
      ? `网关在线 · 实测可用 ${okCount}/${mine.length || 0}`
      : '网关没起来，先跑 start-gateway.sh',
    gatewayTone: gatewayOk ? 'good' : 'bad',
    providerKey: activeProvider,
    providerTitle: p.title,
    providerLabel: p.label,
    // 状态和它是哪一秒产生的绑在一起，60 秒一跳，同源同刻
    gatewayAt: gwMs ? `${clockOf(gwMs)} · ${agoOf(gwMs)}` : '正在校验…',
    gatewayClock: gwMs ? clockOf(gwMs) : '',
    account: q?.user || accountOf() || '未登录',
    modelCount: `${mine.length || 0} 个`,
    quotaText: q ? `剩 ${short(q.left)} / ${short(q.limit)}（已用 ${q.pct}%）${q.extra ? ` · 额外 ${short(q.extra.left)}/${short(q.extra.limit)}` : ''}` : '未知（还没发过请求）',
    quotaLeft: q ? `剩 ${short(q.left)}` : '',
    quotaPct: q?.pct ?? null,
    quotaUsedText: q ? `${short(q.used)} / ${short(q.limit)}` : '—',
    extraText: q?.extra ? `已用 ${short(q.extra.used)} / ${short(q.extra.limit)}` : '—',
    deepseekText: q?.deepseek ? `剩 ${shortM(q.deepseek.left)} / ~${shortM(q.deepseek.limit)}${q.deepseek.reset ? ` · ${resetClock(q.deepseek.reset)}重置` : ''}` : '—',
    quotaLeftPct: q ? `${100 - q.pct}%` : '—',
    quotaBar: q ? Math.max(0, 100 - q.pct) : 0,
    quotaBarTone: q ? (q.pct >= 90 ? 'bad' : q.pct >= 70 ? 'warn' : 'good') : undefined,
    planText: q?.plan || '—',
    quotaAt: q?.readAt ? `额度写入 ${agoOf(Date.parse(String(q.readAt).replace(/(\.\d{3})\d+/, '$1')))}` : '',
    hist: hist ?? { categories: [], values: [] },
    hasHist: Boolean(hist),
    models: items.length ? items : [{ title: '拉不到模型列表', subtitle: GW }],
    lastTest: state.checkedAt ? `上次实测 ${state.checkedAt.slice(5, 16).replace('T', ' ')}` : '还没测过'
  }
}

export function apply(ctx) {
  // 引擎每次启动都会走到 apply —— 网关跟着引擎一起活，App 重启后自动回来
  setTimeout(() => {
    ensureGateway().catch(() => {})
  }, 2500)
  // 运行期也守着：网关中途自己挂了，90 秒内拉回来
  const guard = setInterval(() => {
    ensureGateway().catch(() => {})
  }, 90_000)
  if (typeof guard.unref === 'function') guard.unref()

  ctx.inject(['dshGo'], (ctx) => {
    // 胶囊 ①：打开面板
    ctx.dshGo.on('open-magpie', () => ({ open: 'panel:magpie' }))

    // 胶囊 ②：真发一条最小请求，验当前还能不能用
    ctx.dshGo.on('magpie-test', () => ({
      pending: { label: '正在测 DeepSeek', timeoutMs: 30_000 },
      result: async (signal) => {
        const model = 'marvis/deepseek-v4-1-flash-261017'
        const started = Date.now()
        // 网关没起来就自己拉一次 —— App 重启 / 手机冻结后网关进程会死
        const booted = await ensureGateway(2000)
        if (booted) await new Promise((r) => setTimeout(r, 9000))
        try {
          const ctl = new AbortController()
          const timer = setTimeout(() => ctl.abort(), 25_000)
          if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true })
          const res = await fetch(`${GW}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: '只回答两个字：能通' }],
              max_tokens: 40
            }),
            signal: ctl.signal
          })
          clearTimeout(timer)
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.error) {
            const msg = String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 40)
            const st = readState()
            writeState({ ...st, checkedAt: new Date().toISOString(), models: { ...(st.models ?? {}), [model]: 'no' } })
            gwCache = { ok: false, at: Date.now() }
            return { toast: `失败：${msg}`, patch: { gatewayTone: 'bad', gatewayAt: `失败于 ${clockOf(Date.now())}` } }
          }
          const sec = ((Date.now() - started) / 1000).toFixed(1)
          const st = readState()
          writeState({ ...st, checkedAt: new Date().toISOString(), models: { ...(st.models ?? {}), [model]: 'ok' } })
          // 这次请求真的通了 → 网关状态与时刻一起更新，仍然是同一对
          gwCache = { ok: true, at: Date.now() }
          // 刚发过请求 → magpie 会重写额度文件，立刻重读一次
          quotaCache = { key: '', data: quotaCache.data }
          return { toast: `${booted ? '已自动拉起网关 · ' : ''}通了 ${sec}s`, refresh: true }
        } catch (err) {
          return { toast: `没通：${String(err?.message ?? err).slice(0, 30)}` }
        }
      }
    }))

    // 状态条：输入框上方一行（额度变化即推，不靠定时拉）
    ctx.dshGo.strip('magpie-state', (scope, emit) => {
      let stopped = false
      let last = ''
      let prevLeft = null
      let arrowUntil = 0
      let arrowTimer = null

      const push = async () => {
        if (stopped) return
        let q = quotaFast()
        // quotas.json 没有这个 provider（社区 workbuddy 不写）→ 问一次网关，15 秒缓存
        if (!q) q = await quotaFromGateway(provOf())
        if (stopped) return
        let text
        let tone
        if (gwCache.ok === false && !q) {
          text = `${provOf().label} 掉线`
          tone = 'bad'
        } else if (!q) {
          text = `${provOf().label} · 额度未知`
          tone = 'good'
        } else {
          // 额度掉了一截（自己刚用完 / 同账号在别处被花）→ 挂 4 秒的 ↓，随后自己撤掉
          if (prevLeft !== null && q.left < prevLeft) arrowUntil = Date.now() + 4000
          if (q.left !== prevLeft) prevLeft = q.left
          const arrow = Date.now() < arrowUntil
          // 一位小数：magpie 每轮只掉 0.05%~0.1%，取整在屏幕上等于没变
          text = `${provOf().label} ${q.leftPct.toFixed(1)}% 剩 ${short1(q.left)}${arrow ? '↓' : ''}`
          tone = q.pct >= 90 ? 'warn' : 'good'
          if (arrow) {
            if (arrowTimer) clearTimeout(arrowTimer)
            arrowTimer = setTimeout(() => {
              if (!stopped) push()
            }, 4300)
          }
        }
        if (text === last) return
        last = text
        emit({ text, icon: 'cloud', tone })
      }

      push()
      stripPushers.add(push)
      // 额度文件一变立刻推 —— 聊完一句，胶囊马上反映扣了多少
      watchFile(QUOTAS, { interval: 400, persistent: false }, push)
      // 兜底：跟着 60 秒的校验节奏走，不额外打网关
      const beat = setInterval(async () => {
        await probeGateway()
        push()
      }, PROBE_TTL)
      if (typeof beat.unref === 'function') beat.unref()
      // workbuddy 不在 quotas.json（社区插件不写）→ watchFile 不会触发；靠这条 5 秒轮询让它也动态跳
      const qbeat = setInterval(push, 5_000)
      if (typeof qbeat.unref === 'function') qbeat.unref()
      probeGateway().then(push)

      return () => {
        stopped = true
        stripPushers.delete(push)
        unwatchFile(QUOTAS, push)
        clearInterval(beat)
        clearInterval(qbeat)
      }
    })

    // 面板
    ctx.dshGo.panel('magpie', {
      view: (scope, caps) => ({
        v: 2,
        type: 'stack',
        title: { $: 'data.providerTitle' },
        children: [
          { type: 'callout', text: { $: 'data.gatewayText' }, tone: { $: 'data.gatewayTone' } },
          {
            type: 'options',
            id: 'pick-provider',
            options: [
              { label: '小浣熊', value: 'raccoon' },
              { label: 'WorkBuddy', value: 'workbuddy' },
              { label: 'Qoder CN', value: 'qoder-cn' },
              { label: '腾讯 Marvis', value: 'marvis' }
            ],
            selected: { $: 'data.providerKey' }
          },
          {
            type: 'progress',
            label: '剩余额度',
            value: { $: 'data.quotaBar' },
            max: 100,
            caption: { $: 'data.quotaText' },
            tone: { $: 'data.quotaBarTone' }
          },
          {
            type: 'keyValue',
            items: [
              { label: '账号', value: { $: 'data.account' } },
              { label: '计划', value: { $: 'data.planText' } },
              { label: '模型', value: { $: 'data.modelCount' } },
              { label: '网关校验', value: { $: 'data.gatewayAt' } },
              { label: '已用', value: { $: 'data.quotaUsedText' } },
              { label: '额外额度', value: { $: 'data.extraText' } },
              { label: 'DeepSeek 每日', value: { $: 'data.deepseekText' } },
              { label: '剩余占比', value: { $: 'data.quotaLeftPct' } },
              { label: '地址', value: '127.0.0.1:3425' }
            ]
          },
          { type: 'text', text: { $: 'data.quotaAt' }, tone: 'muted' },
          {
            type: 'chart',
            kind: 'line',
            categories: { $: 'data.hist.categories' },
            series: [{ name: '剩余 %', values: { $: 'data.hist.values' } }],
            unit: '%',
            caption: '额度采样（每次请求后记录）'
          },
          { type: 'text', text: { $: 'data.lastTest' }, tone: 'muted' },
          { type: 'list', items: { $: 'data.models' } },
          {
            type: 'actions',
            items: [
              { label: '刷新', action: 'refresh' },
              { label: '测模型', action: 'test' }
            ]
          },
          {
            type: 'text',
            text: '额度文件一变胶囊立刻更新；网关状态 60 秒校验一次，时间戳与状态同一次探测',
            tone: 'muted'
          }
        ]
      }),
      data: async (scope, emit) => {
        let stopped = false
        const push = async () => {
          if (stopped) return
          emit(await snapshot())
        }
        await push()
        // 1.5 秒一屏：额度靠 stat 缓存（微秒级），网关与模型靠 60 秒缓存，
        // 所以这里只有额度在跳，网关状态和时间戳每 60 秒一起换一次 —— 天然同步。
        const fast = setInterval(push, 1_500)
        return () => {
          stopped = true
          clearInterval(fast)
        }
      },
      actions: {
        'pick-provider': (scope, event) => {
          const next = String(event?.value?.value ?? '')
          if (!PROVIDERS[next]) return { toast: '没有这个 provider' }
          activeProvider = next
          try {
            writeFileSync(PROVIDER_FILE, JSON.stringify({ provider: next }))
          } catch {
            /* 记不住也不影响本次切换 */
          }
          quotaCache = { key: '', data: null }
          // 胶囊立刻跟着换，不用等额度文件变动
          for (const push of stripPushers) push()
          return { refresh: true, toast: `只看${PROVIDERS[next].label}` }
        },
        refresh: async () => {
          // 手动刷新 = 强制重探一次，状态与时刻一起跳到现在
          const snap = await snapshot({ forceGateway: true })
          return { patch: snap, toast: snap.gatewayOk ? `已刷新 ${snap.gatewayClock}` : '网关没起来' }
        },
        test: () => ({
          pending: { label: '正在测 DeepSeek', timeoutMs: 30_000 },
          result: async () => {
            const snap = await snapshot({ forceGateway: true })
            return { patch: snap, toast: snap.gatewayOk ? '网关正常' : '网关没起来' }
          }
        })
      }
    })
  })
}
