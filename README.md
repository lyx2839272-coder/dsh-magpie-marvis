# dsh-magpie-marvis · Marvis 503 直连方案 + dsh-go 面板

> 一套让「腾讯 Marvis 免费模型」在网关返回 **503 Service Unavailable** 时仍然可用的胶水方案：
> 把 Marvis 客户端的 WebSocket 会话（openclaw）包装成本地 OpenAI 兼容接口，绕开排队/过载的 HTTP 层；
> 另附一个 dsh-go 手机端面板，实时看网关连通性、额度与模型可用性。

**简体中文** | [English](README_EN.md)

---

## 1. 问题：Marvis 503 是什么

Marvis 官方的 OpenAI 兼容接口（`yybadaccess.3g.qq.com`）在高峰期/高负载下会返回：

- HTTP **503 Service Unavailable**（标准原因短语），或
- 用 `application/json` 的 content-type 却返回整段 SSE 帧（反代行为）。

很多客户端（包括 dsh 的免费模型插件 dsh-our-free-model）会把「5xx 原因短语」误判成「这个模型拒绝你」，于是模型一个个从选择器里消失、整轮失败。本仓库给你两条互补的绕行路线。

## 2. 两条路线

### 路线 A：直连 WS 网关（本仓库 `gateway/marvis_gateway.py`）

不再走 HTTP 的 chat/completions，而是**直接连 Marvis 客户端的 WebSocket（openclaw 协议）**，
用你登录后的 `sessionId` / `token` 建立会话，再把结果打包成本地 OpenAI 接口。
因为完全绕开了 HTTP 网关的排队层，503 基本不会再出现。

```
客户端(OpenAI SDK / dsh)  ──HTTP──▶  127.0.0.1:3499  (marvis_gateway.py)
                                        │  读 handshake.log 的 sessionId/token
                                        └──WSS──▶  Marvis openclaw  (wss://…)
```

### 路线 B：dsh 插件侧的 5xx 容错（见 dsh-our-free-model）

dsh-our-free-model 的 `src/chan-relay.js` / `src/forward.js` 对 5xx 做 fail-closed 归类、
`src/effort.js` 处理上游字段导致的 503、README 记录「5xx 原因短语不再当判定」。
两者配合：HTTP 线继续可用时走插件，堵塞时切路线 A。

## 3. 目录结构

```
gateway/marvis_gateway.py   OpenAI 兼容网关 → Marvis openclaw WS
auth/login.mjs              无头 Chrome + CDP 抓登录回调（marvis_oauth）
auth/exchange.mjs           callback → 账号 JSON（借 magpie-marvis 的 parseCallback）
auth/refresh.mjs            刷新 access token
scripts/probe.mjs           单次探测接口是否 200
scripts/watch.sh            每 20 分钟探测，恢复即写标记
dsh-go-plugin/              dsh-go 手机端「Magpie 网关」面板（状态/额度/测模型）
config.example.json         网关配置模板
```

## 4. 依赖

- **Python 3.9+** 与 `websockets`（`pip install websockets`）
- **Node.js 18+**（内置 fetch / WebSocket / crypto）
- **Google Chrome / Chromium**（登录抓包用，可 `export CHROME_BIN=` 指定路径）
- （可选，auth/ 与 scripts/ 需要）**magpie + magpie-marvis 插件**：本方案的换票/探测复用了
  `magpie-marvis` 的协议头与指纹实现。没装它时，路线 A 的网关仍可独立工作，只要你有握手模板。

## 5. 关键前提：抓一次握手模板

路线 A 需要两个由**你自己登录后抓包**得到的文件（本仓库不含、也不该含）：

- `handshake.log` —— Marvis 客户端与 openclaw 握手时的请求头，含 `sessionId:` / `token:` 两行
- `frames.log` —— 抓到的 WS 帧，其中一条是 `{"method":"connect"...}` 模板

抓法：手机/桌面 Marvis 客户端登录后，用 Proxyman / mitmproxy / Chrome DevTools 抓 WS，保存握手请求与首帧即可。
> 这两个文件随登录/刷新会过期，属正常现象；重新登录再抓一次即可。

## 6. 快速开始

```bash
# 1) 配置
cp config.example.json config.json
# 编辑 config.json：填 marvis_ws_url / model_name / handshake_file / frames_file

# 2) 启动网关（默认 127.0.0.1:3499）
pip install websockets
python3 gateway/marvis_gateway.py

# 3) 任一 OpenAI 客户端把 base_url 指到本地网关
#    base_url = http://127.0.0.1:3499/v1   api_key 随便填
```

也可全用环境变量（优先级高于 config.json）：
`MARVIS_WS_URL` / `MARVIS_MODEL_NAME` / `MARVIS_HANDSHAKE` / `MARVIS_FRAMES` / `MARVIS_GW_HOST` / `MARVIS_GW_PORT`

### 登录 / 换票 / 保活（可选）

```bash
export MAGPIE_HOME=~/.config/magpie          # magpie 配置目录
export MARVIS_GUID=<你的设备 guid>            # 从客户端抓包得到
node auth/login.mjs "<Marvis 登录授权 URL>"   # 出二维码/拦截回调 → marvis-callback.txt
node auth/exchange.mjs                        # → marvis-acct.json
node auth/refresh.mjs                         # 刷新 access token
bash scripts/watch.sh                         # 每 20 分钟探测，恢复写 marvis-recovered.flag
```

### dsh-go 面板

把 `dsh-go-plugin/` 放进 dsh-go 的插件目录（或按 dsh-go 的插件安装机制加载）：
它在手机界面加一个「Magpie」胶囊 + 面板，读 `$MAGPIE_HOME/{logins,quotas,quota-history}.json` 与本地网关
（默认 `http://127.0.0.1:3425`，可用 `MAGPIE_GW_URL` 覆盖）显示状态、余额和测模型结果。

## 7. 安全与合规

- **本仓库不含任何账号凭证**。`marvis-acct.json` / `plugin-auth.json` / `*.log` / 二维码 png 都在 `.gitignore` 里，请勿提交。
- 你的 `sessionId` / `token` / `refreshToken` / `openid` / `guid` 等同账号密码，泄露即被盗用。
- Marvis 是腾讯提供的免费服务，**条款与可用性由上游决定、随时可能变更或收紧**。本项目仅做协议层适配，请自行评估并遵守服务条款，风险自负。

## 8. 常见问题

- **还是 503？** 路线 A 是绕开 HTTP 层；若 WS 也报错，多半是账号被风控或握手模板过期，重新登录抓包。
- **模型列表空？** `/v1/models` 返回的是 `config.json` 里的 `model_name`，填对即可。
- **换票失败？** `exchange/refresh` 依赖 magpie-marvis 插件与有效 refresh token，先确认 `plugin-auth.json` 存在。
- **面板没数据？** 检查 `MAGPIE_HOME` 路径下是否有 `logins.json / quotas.json`（magpie 请求后会自动刷新）。

## License

MIT，见 [LICENSE](LICENSE)。
