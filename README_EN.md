# dsh-magpie-marvis · Marvis 503 direct-connect gateway + dsh-go panel

> A small glue that keeps Tencent **Marvis** free models usable when the gateway answers
> **503 Service Unavailable**: it wraps the Marvis client WebSocket (openclaw) into a local
> OpenAI-compatible endpoint, bypassing the overloaded HTTP queue — plus a dsh-go phone panel
> showing gateway health, quota and per-model availability.

**English** | [简体中文](README.md)

---

## 1. The problem: Marvis 503

Marvis's OpenAI-compatible endpoint (yybadaccess.3g.qq.com) under load returns either
HTTP **503** (standard reason phrase), or an `application/json` content-type carrying a full SSE
frame sequence. Clients (including dsh's free-model plugin *dsh-our-free-model*) may misread the
"5xx reason phrase" as "this model refuses you", dropping models one by one and failing the turn.
This repo gives two complementary workarounds.

## 2. Two routes

### Route A — direct WS gateway (gateway/marvis_gateway.py)

Skip the HTTP chat/completions path; connect straight to the Marvis client **WebSocket (openclaw)**
using the `sessionId` / `token` from your login, then repackage the result as a local OpenAI endpoint.

```
client (OpenAI SDK / dsh) ──HTTP──▶ 127.0.0.1:3499 (marvis_gateway.py)
                                       │ reads sessionId/token from handshake.log
                                       └──WSS──▶ Marvis openclaw (wss://…)
```

### Route B — plugin-side 5xx tolerance (see dsh-our-free-model)

dsh-our-free-model's src/chan-relay.js & src/forward.js fail-close on 5xx, src/effort.js handles
upstream-field 503s, and its README records "5xx reason phrase no longer treated as a verdict".

## 3. Layout

```
gateway/marvis_gateway.py   OpenAI-compatible gateway -> Marvis openclaw WS
auth/login.mjs              headless Chrome + CDP to capture the marvis_oauth callback
auth/exchange.mjs           callback -> account JSON (uses magpie-marvis parseCallback)
auth/refresh.mjs            refresh access token
scripts/probe.mjs           one-shot reachability probe (expects HTTP 200)
scripts/watch.sh            probe every 20 min, write a flag on recovery
dsh-go-plugin/              dsh-go phone "Magpie gateway" panel (status/quota/model test)
config.example.json         gateway config template
```

## 4. Requirements

- **Python 3.9+** with `websockets` (`pip install "websockets>=12"`; code handles both 12-13 extra_headers and 14+ additional_headers)
- **Node.js 22+** (login.mjs needs global WebSocket; built-in fetch / crypto)
- **Google Chrome / Chromium** (for login capture; override with CHROME_BIN)
- (optional, for auth/ and scripts/) **magpie + magpie-marvis plugin**: token exchange & probing reuse
  its protocol headers and fingerprint. Route A works standalone if you already have the handshake files.

## 5. Key prerequisite: capture a handshake template once

Route A needs two files obtained by **your own login capture** (never shipped here):

- `handshake.log` — the openclaw handshake request headers, containing `sessionId:` and `token:` lines
- `frames.log` — captured WS frames; one of them is a `{"method":"connect"...}` template

Capture with Proxyman / mitmproxy / Chrome DevTools after logging into the Marvis client.
> These files expire with the session — just log in and re-capture.

## 6. Quick start

```bash
cp config.example.json config.json
# fill marvis_ws_url / model_name / handshake_file / frames_file
pip install websockets
python3 gateway/marvis_gateway.py            # 127.0.0.1:3499
# point any OpenAI client to base_url=http://127.0.0.1:3499/v1 (api_key arbitrary)
```

Env vars override config.json:
MARVIS_WS_URL / MARVIS_MODEL_NAME / MARVIS_HANDSHAKE / MARVIS_FRAMES / MARVIS_GW_HOST / MARVIS_GW_PORT

### Login / refresh / keep-alive (optional)

```bash
export MAGPIE_HOME=~/.config/magpie
export MARVIS_GUID=<your device guid>          # captured from the client
node auth/login.mjs "<Marvis auth URL>"        # -> marvis-callback.txt
node auth/exchange.mjs                          # -> marvis-acct.json
node auth/refresh.mjs
bash scripts/watch.sh
```

### dsh-go panel

Drop dsh-go-plugin/ into your dsh-go plugin directory. It adds a "Magpie" capsule + panel that reads
$MAGPIE_HOME/{logins,quotas,quota-history}.json and the local gateway (http://127.0.0.1:3425,
override with MAGPIE_GW_URL). Note: 3425 is magpie's own gateway; this repo's marvis_gateway.py defaults to 3499 — they differ.

## 7. Security & compliance

- **No credentials in this repo.** marvis-acct.json / plugin-auth.json / *.log / QR png are gitignored.
- sessionId / token / refreshToken / openid / guid are account secrets — treat them like a password.
- Marvis is a free service by Tencent; **terms and availability are set by upstream and may change anytime.**
  This project only adapts the protocol. Use at your own risk and comply with the ToS.

## 8. FAQ

- **Still 503?** Route A bypasses HTTP; if the WS errors too, the account is likely rate-limited or the
  handshake template expired — re-login and re-capture.
- **Empty model list?** /v1/models returns your config.json model_name; set it correctly.
- **Exchange/refresh fails?** They need the magpie-marvis plugin and a valid refresh token.

## License

MIT — see [LICENSE](LICENSE).
