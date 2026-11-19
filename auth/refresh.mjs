// 用 refresh token 换新的 access token（写回 magpie 的 plugin-auth.json）。
// 环境变量: MAGPIE_HOME(默认 ~/.config/magpie)  MARVIS_API_BASE(默认 https://yybadaccess.3g.qq.com)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HOME = process.env.HOME || '/root'
const MAGPIE_HOME = process.env.MAGPIE_HOME || path.join(HOME, '.config', 'magpie')
const API_BASE = process.env.MARVIS_API_BASE || 'https://yybadaccess.3g.qq.com'
const P = path.join(MAGPIE_HOME, 'plugins/node_modules/magpie-marvis/src/marvis')
const { businessHeaders } = await import(P + '/protocol.mjs')
const F = path.join(MAGPIE_HOME, 'plugin-auth.json')
const raw = JSON.parse(readFileSync(F, 'utf8'))
const a = raw.marvis
const acct = { openid: a.uid, accessToken: a.access, guid: a.metadata.guid, loginType: a.metadata.loginType }
const body = JSON.stringify({ userInfo: { openId: a.uid, refreshToken: a.refresh, accessToken: a.access, loginType: 'Marvis' } })
const r = await fetch(API_BASE + '/marvis_client_login/marvis_refresh_token', {
  method: 'POST', headers: businessHeaders(acct, { query: body, method: 'POST' }), body,
  signal: AbortSignal.timeout(30000),
})
const t = await r.text()
console.log('REFRESH', r.status, t.slice(0, 300))
try {
  const j = JSON.parse(t)
  const info = j?.user_info ?? j?.data
  const na = info?.access_token ?? info?.accessToken
  if (Number(j?.code) === 0 && na) {
    raw.marvis.access = na
    if (info.refresh_token) raw.marvis.refresh = info.refresh_token
    if (info.expires_in) raw.marvis.expires = Date.now() + Number(info.expires_in) * 1000
    writeFileSync(F, JSON.stringify(raw, null, 2))
    console.log('SAVED new access', String(na).slice(0, 12) + '...')
  } else console.log('NO NEW TOKEN code=', j?.code, j?.msg)
} catch (e) { console.log('parse fail', e.message) }
