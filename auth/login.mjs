// Marvis 登录:无头 Chrome + CDP 拦截 OAuth 回调,callback URL 落到 marvis-callback.txt。
// 用法: node login.mjs "<Marvis 登录授权 URL>"
// 可配环境变量(均有默认,按你的机器改):
//   WORKDIR 工作目录(默认当前目录)   CHROME_BIN Chrome 路径(默认 /usr/bin/google-chrome)
//   CDP_PORT 调试端口(默认 9222)      CHROME_PROFILE 用户目录(默认 /tmp/marvis-profile)
import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const WORKDIR = process.env.WORKDIR || process.cwd()
const LOG = path.join(WORKDIR, 'marvis-login.log')
const CALLBACK_FILE = path.join(WORKDIR, 'marvis-callback.txt')
const QR_PNG = path.join(WORKDIR, 'marvis-qr.png')
const log = (m) => { appendFileSync(LOG, new Date().toISOString().slice(11, 19) + ' ' + m + '\n'); console.log(m) }
const AUTH_URL = process.argv[2]
const PORT = Number(process.env.CDP_PORT || 9222)
const PROFILE = process.env.CHROME_PROFILE || '/tmp/marvis-profile'
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/google-chrome'

if (!AUTH_URL) { console.error('用法: node login.mjs "<Marvis 登录授权 URL>"'); process.exit(1) }
writeFileSync(LOG, '')
try { rmSync(CALLBACK_FILE) } catch {}

const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'
], { stdio: 'ignore', detached: true })
chrome.unref()
log('chrome spawned pid=' + chrome.pid)

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await r.json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('devtools 未就绪')
}

const page = await findPage()
log('page target=' + page.id)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})

let done = false
async function onPaused(p) {
  const url = p.request?.url ?? ''
  if (/marvis_oauth/i.test(url) && /[?&]code=/.test(url)) {
    log('CALLBACK ' + url.slice(0, 400))
    writeFileSync(CALLBACK_FILE, url)
    try {
      await send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from('<h1>登录回调已拦截，可以关掉这个窗口了</h1>').toString('base64'),
      })
    } catch (e) { log('fulfill err ' + e.message) }
    done = true
    return
  }
  try { await send('Fetch.continueRequest', { requestId: p.requestId }) } catch {}
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result)
    return
  }
  if (msg.method === 'Fetch.requestPaused') onPaused(msg.params)
}
ws.onerror = (e) => log('ws error ' + (e?.message ?? ''))

await new Promise((r) => (ws.onopen = r))
await send('Page.enable')
await send('Fetch.enable', { patterns: [{ urlPattern: '*marvis_oauth*', requestStage: 'Request' }] })
log('fetch interception on')
await send('Page.navigate', { url: AUTH_URL })
log('navigated')
await new Promise((r) => setTimeout(r, 4000))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(QR_PNG, Buffer.from(shot.data, 'base64'))
log('screenshot saved')

const deadline = Date.now() + 8 * 60 * 1000
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
log(done ? 'DONE callback captured' : 'TIMEOUT no callback')
try { ws.close() } catch {}
try { chrome.kill('SIGKILL') } catch {}
process.exit(0)
