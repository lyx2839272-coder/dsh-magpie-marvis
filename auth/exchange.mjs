// 把 login.mjs 拦到的 callback URL 换成 Marvis 账号 JSON(acct)。
// 依赖上游 magpie-marvis 插件的 parseCallback —— 需先在 magpie 里装好 magpie-marvis。
// 环境变量: WORKDIR(默认当前目录)  MAGPIE_HOME(默认 ~/.config/magpie)  MARVIS_GUID(必需,设备 guid)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HOME = process.env.HOME || '/root'
const MAGPIE_HOME = process.env.MAGPIE_HOME || path.join(HOME, '.config', 'magpie')
const WORKDIR = process.env.WORKDIR || process.cwd()
const { parseCallback } = await import(path.join(MAGPIE_HOME, 'plugins/node_modules/magpie-marvis/src/marvis/login.mjs'))
const url = readFileSync(path.join(WORKDIR, 'marvis-callback.txt'), 'utf8').trim()
const guid = process.env.MARVIS_GUID || ''
if (!guid) { console.error('请先设置 MARVIS_GUID'); process.exit(1) }
try {
  const acct = await parseCallback(url, '', { loginType: 'QC', guid })
  writeFileSync(path.join(WORKDIR, 'marvis-acct.json'), JSON.stringify(acct, null, 2))
  console.log('OK', JSON.stringify({ type: acct?.type, uid: acct?.uid, accountId: acct?.accountId, expires: acct?.expires, nickname: acct?.nickname ?? acct?.metadata?.nickname }))
} catch (e) { console.log('FAIL', e?.code ?? '', e?.message ?? String(e)) }
