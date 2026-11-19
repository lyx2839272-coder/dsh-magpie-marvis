# -*- coding: utf-8 -*-
# marvis_gateway.py -- OpenAI-compatible gateway -> Marvis openclaw WebSocket
#
# 把 Marvis 的 WebSocket 会话(openclaw)包装成一个本地 OpenAI 兼容接口，
# 任何支持 OpenAI Chat Completions 的客户端 / dsh 插件都能直接用它。
#
# 配置来源(优先级：环境变量 > 同目录 config.json)：
#   MARVIS_WS_URL       Marvis openclaw WebSocket 地址(wss://...)
#   MARVIS_MODEL_NAME   暴露给客户端的模型名
#   MARVIS_HANDSHAKE    握手抓包文件(含 sessionId / token)
#   MARVIS_FRAMES       帧模板文件(含 {"method":"connect"} 模板)
#   MARVIS_GW_HOST/Port 本地监听(默认 127.0.0.1:3499)
#
# 握手/帧模板来自你自己登录后对 Marvis 客户端的一次抓包，详见 README。
import asyncio, ssl, json, uuid, re, time, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import websockets

def _cfg():
    here = os.path.dirname(os.path.abspath(__file__))
    cfg = {}
    p = os.path.join(here, 'config.json')
    if os.path.exists(p):
        try: cfg = json.load(open(p, encoding='utf-8'))
        except Exception: cfg = {}
    g = cfg.get('gateway', {}) if isinstance(cfg, dict) else {}
    return {
        'url': os.environ.get('MARVIS_WS_URL') or g.get('marvis_ws_url') or '',
        'model': os.environ.get('MARVIS_MODEL_NAME') or g.get('model_name') or 'marvis-model',
        'hs': os.environ.get('MARVIS_HANDSHAKE') or g.get('handshake_file') or os.path.join(here, 'handshake.log'),
        'fr': os.environ.get('MARVIS_FRAMES') or g.get('frames_file') or os.path.join(here, 'frames.log'),
        'host': os.environ.get('MARVIS_GW_HOST') or g.get('host') or '127.0.0.1',
        'port': int(os.environ.get('MARVIS_GW_PORT') or g.get('port') or 3499),
    }

CFG = _cfg()
URL = CFG['url']; HS = CFG['hs']; FR = CFG['fr']; MODEL_NAME = CFG['model']

def creds():
    hs = open(HS, encoding='utf-8', errors='replace').read()
    sid = re.search(r'sessionId:\s*([0-9a-f-]+)', hs).group(1)
    tok = re.search(r'token:\s*([0-9a-f-]+)', hs).group(1)
    return sid, tok

def load_conn():
    fr = open(FR, encoding='utf-8', errors='replace').read().split('\n-----\n')
    for p in fr:
        if '"method":"connect"' in p:
            try: return json.loads(p.strip())
            except: pass
    raise RuntimeError("no connect template in frames file")

def flatten(msgs):
    out = []
    for m in msgs:
        c = m.get('content')
        if isinstance(c, list): c = ''.join(x.get('text', '') for x in c if isinstance(x, dict))
        out.append(str(m.get('role', 'user')) + ": " + str(c))
    return "\n".join(out)

async def chat_once(prompt):
    sid, tok = creds(); conn = load_conn(); conn['id'] = str(uuid.uuid4())
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    hdrs = [("sessionId", sid), ("token", tok), ("platform", "mobile"), ("role", "operator"), ("version", str(int(time.time()*1000)))]
    async with websockets.connect(URL, extra_headers=hdrs, ssl=ctx, open_timeout=10) as ws:
        await ws.send(json.dumps(conn)); await asyncio.wait_for(ws.recv(), timeout=8)
        rid = str(uuid.uuid4())
        await ws.send(json.dumps({"type":"req","id":rid,"method":"chat.send","params":{"sessionKey":"agent:main:main","message":prompt}}))
        last = ''; t0 = time.time()
        while time.time() - t0 < 180:
            try: m = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                if last: break
                continue
            try: o = json.loads(m)
            except: continue
            if o.get('type') == 'event' and o.get('event') == 'chat':
                txt = ''.join(c.get('text','') for c in o.get('payload',{}).get('message',{}).get('content',[]) if isinstance(c,dict))
                if txt: last = txt
            if o.get('type') == 'event' and o.get('event') == 'agent':
                ph = o.get('payload',{}).get('data',{}).get('phase')
                if ph == 'complete': break
                if ph == 'error': return "[" + str(o['payload']['data'].get('reason')) + "]"
        return last

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith('/v1/models'):
            self._json({"object":"list","data":[{"id":MODEL_NAME,"object":"model","owned_by":"tencent-marvis"}]})
        else: self._json({"ok":True})
    def do_POST(self):
        if not self.path.startswith('/v1/chat/completions'):
            self._json({"error":"not found"}, 404); return
        n = int(self.headers.get('Content-Length', 0)); body = json.loads(self.rfile.read(n) or b'{}')
        msgs = body.get('messages', []); prompt = flatten(msgs); stream = body.get('stream')
        try: text = asyncio.run(chat_once(prompt))
        except Exception as e:
            self._json({"error":str(e)}, 500); return
        cid = "chatcmpl-" + uuid.uuid4().hex[:12]; ts = int(time.time())
        if stream:
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Cache-Control','no-cache'); self.end_headers()
            def ev(o): self.wfile.write(("data: " + json.dumps(o, ensure_ascii=False) + "\n\n").encode()); self.wfile.flush()
            ev({"id":cid,"object":"chat.completion.chunk","created":ts,"model":MODEL_NAME,"choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":None}]})
            ev({"id":cid,"object":"chat.completion.chunk","created":ts,"model":MODEL_NAME,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        else:
            self._json({"id":cid,"object":"chat.completion","created":ts,"model":MODEL_NAME,"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}})

if __name__ == "__main__":
    if not URL:
        raise SystemExit("MARVIS_WS_URL 未配置：请在 config.json 或环境变量里填 Marvis openclaw WebSocket 地址")
    print(f"Marvis gateway on {CFG['host']}:{CFG['port']} -> {URL}", flush=True)
    ThreadingHTTPServer((CFG['host'], CFG['port']), H).serve_forever()
