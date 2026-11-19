// 单次探测 Marvis 官方 OpenAI 兼容接口是否可用(HTTP 200)。
// 环境变量: MAGPIE_HOME(默认 ~/.config/magpie)  MARVIS_API_HOST(默认 yybadaccess.3g.qq.com)
//           MARVIS_MODEL_ID(默认 REPLACE_WITH_MODEL_ID)
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import path from 'node:path'

const HOME = process.env.HOME || '/root'
const MAGPIE_HOME = process.env.MAGPIE_HOME || path.join(HOME, '.config', 'magpie')
const API_HOST = process.env.MARVIS_API_HOST || 'yybadaccess.3g.qq.com'
const MODEL = process.env.MARVIS_MODEL_ID || 'REPLACE_WITH_MODEL_ID'
const P = path.join(MAGPIE_HOME, 'plugins/node_modules/magpie-marvis/src/marvis')
const { llmHeaders } = await import(P + '/protocol.mjs')
const { uskeyOf } = await import(P + '/fingerprint.mjs')
const a = JSON.parse(readFileSync(path.join(MAGPIE_HOME, 'plugin-auth.json'), 'utf8')).marvis
const acct = { openid: a.uid, accessToken: a.access, guid: a.metadata.guid, loginType: a.metadata.loginType }
const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 4, stream: false })
function once(family) {
  return new Promise((res) => {
    const h = llmHeaders(acct, {})
    h['Ual-Access-MarvisExt'] = JSON.stringify({ osVersion: 'Windows-10-10.0.26200', guid: acct.guid, uskey: uskeyOf('marvis_client'), nonce: randomUUID(), reqScene: 1, taskType: 'user', clientVersion: '1.60.3300.765', isIoa: false })
    h['Content-Length'] = Buffer.byteLength(body)
    const r = https.request({ host: API_HOST, path: '/v1/chat/completions', method: 'POST', headers: h, family, timeout: 40000 }, (s) => {
      let t = ''; s.on('data', (c) => (t += c)); s.on('end', () => res('family' + family + ' ' + s.statusCode + ' ' + t.slice(0, 120)))
    })
    r.on('error', (e) => res('family' + family + ' ERR ' + e.message))
    r.on('timeout', () => { r.destroy(); res('family' + family + ' TIMEOUT') })
    r.end(body)
  })
}
console.log(await once(4))
console.log(await once(6))
