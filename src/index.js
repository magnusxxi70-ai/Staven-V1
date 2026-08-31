import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { config } from './config.js';
import {
  loadSessionState,
  getSessionState,
  registerSession,
  replaceSession,
  removeSession,
  checkSession,
} from './session.js';
import { protections, redact } from './security.js';

process.on('uncaughtException', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));
process.on('unhandledRejection', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

/* ── Token-based session auth ────────────────────────────── */
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
const activeTokens = new Map();

function generateToken() {
  const token = crypto.randomUUID();
  activeTokens.set(token, Date.now() + TOKEN_TTL);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) { activeTokens.delete(token); return false; }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of activeTokens) { if (now > exp) activeTokens.delete(t); }
}, 60 * 60 * 1000);

function parseCookies(req) {
  const c = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [k, ...r] = pair.trim().split('=');
    if (k) c[k.trim()] = r.join('=').trim();
  }
  return c;
}

function requireAuth(req, res, next) {
  if (isValidToken(parseCookies(req)['staven_token'])) return next();
  return res.redirect('/login');
}

/* ── Public routes ───────────────────────────────────────── */

app.get('/health', (_req, res) => res.json({
  ok: true, name: 'STAVEN BLUE V1', uptime: process.uptime()
}));

app.get('/login', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
.login-box{background:#131720;border:1px solid #252b38;border-radius:18px;padding:40px;width:100%;max-width:380px;box-shadow:0 10px 35px #0003}
h1{font-size:22px;margin-bottom:4px}
.subtitle{color:#929caf;margin-bottom:28px;font-size:14px}
.field{margin-bottom:16px}
.field label{display:block;font-size:13px;color:#929caf;margin-bottom:6px}
.field input{width:100%;padding:11px 14px;border:1px solid #252b38;border-radius:11px;background:#0e1017;color:#eef1f6;font-size:15px;outline:none;transition:border-color .2s}
.field input:focus{border-color:#4f7cff}
button{width:100%;padding:12px;border:0;border-radius:11px;background:#4f7cff;color:#fff;font-weight:700;font-size:15px;cursor:pointer;transition:background .2s}
button:hover{background:#3d6ae0}
.error{color:#ff6b6b;font-size:13px;margin-bottom:14px;display:none}
</style>
</head>
<body>
<div class="login-box">
  <h1>STAVEN BLUE V1</h1>
  <div class="subtitle">Control Center Login</div>
  <div class="error" id="err">Invalid username or password</div>
  <form method="POST" action="/login">
    <div class="field">
      <label for="u">Username</label>
      <input type="text" id="u" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label for="p">Password</label>
      <input type="password" id="p" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign In</button>
  </form>
</div>
<script>
if(new URLSearchParams(location.search).get('error')==='1')document.getElementById('err').style.display='block';
</script>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.dashboardUser && password === config.dashboardPassword) {
    const token = generateToken();
    res.setHeader('Set-Cookie', `staven_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL / 1000}`);
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'staven_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return res.redirect('/login');
});

/* ── Protected API routes ────────────────────────────────── */
function apiAuth(req, res, next) {
  if (isValidToken(parseCookies(req)['staven_token'])) return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    try {
      const d = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const i = d.indexOf(':');
      if (i >= 0 && d.slice(0, i) === config.dashboardUser && d.slice(i + 1) === config.dashboardPassword) return next();
    } catch {}
  }
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', apiAuth, (_req, res) => res.json({
  ok: true, name: 'STAVEN BLUE V1', uptime: process.uptime()
}));

app.get('/api/session', apiAuth, (_req, res) => {
  res.json(getSessionState());
});

app.post('/api/session/register', apiAuth, async (req, res) => {
  try {
    const appState = req.body?.appState;
    if (!appState) return res.status(400).json({ ok: false, error: 'appState is required in request body' });
    const result = await registerSession(appState);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to register session' });
  }
});

app.post('/api/session/replace', apiAuth, async (req, res) => {
  try {
    const appState = req.body?.appState;
    if (!appState) return res.status(400).json({ ok: false, error: 'appState is required in request body' });
    const result = await replaceSession(appState);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to replace session' });
  }
});

app.post('/api/session/remove', apiAuth, async (_req, res) => {
  try {
    const result = await removeSession();
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to remove session' });
  }
});

app.post('/api/session/check', apiAuth, async (_req, res) => {
  try {
    const result = await checkSession();
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to check session' });
  }
});

/* ── Dashboard (protected by cookie) ────────────────────── */
app.get('/', requireAuth, (_req, res) => {
  const protectionText = JSON.stringify(protections.map(x => '\u2713 ' + x).join('\n'));
  const authB64 = Buffer.from(config.dashboardUser + ':' + config.dashboardPassword).toString('base64');

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 Control Center</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:auto;padding:28px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px}
h1{margin:0;font-size:34px}
h2{margin:0 0 16px;font-size:20px;color:#eef1f6}
.muted{color:#929caf}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
.card{background:#131720;border:1px solid #252b38;border-radius:18px;padding:20px;box-shadow:0 10px 35px #0003}
.v{font-size:27px;font-weight:750;margin-top:8px}
button{padding:11px 15px;border:0;border-radius:11px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:disabled{opacity:.5;cursor:not-allowed}
pre{white-space:pre-wrap;line-height:1.65}
.status{margin-top:12px}
.btn-secondary{background:#252b38;color:#eef1f6}.btn-secondary:hover{background:#353d4e}
.top-right{display:flex;gap:10px;align-items:center}
.btn-sm{padding:7px 14px;font-size:13px}
.btn-green{background:#16a34a;color:#fff}.btn-green:hover{background:#15803d}
.btn-blue{background:#2563eb;color:#fff}.btn-blue:hover{background:#1d4ed8}
.btn-orange{background:#d97706;color:#fff}.btn-orange:hover{background:#b45309}
.btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
.session-info{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;font-size:14px}
.session-info .lbl{color:#929caf}
.session-info .val{color:#eef1f6;font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid #252b38}
.appstate-area{margin-top:16px}
.appstate-area label{display:block;font-size:13px;color:#929caf;margin-bottom:6px}
.appstate-area textarea{width:100%;min-height:80px;padding:10px 12px;border:1px solid #252b38;border-radius:11px;background:#0e1017;color:#eef1f6;font-size:13px;font-family:monospace;resize:vertical;outline:none;transition:border-color .2s}
.appstate-area textarea:focus{border-color:#4f7cff}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:11px;font-weight:600;font-size:14px;z-index:9999;display:none;box-shadow:0 4px 15px #0005;max-width:90vw}
.toast-ok{background:#16a34a;color:#fff}
.toast-err{background:#dc2626;color:#fff}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-green{background:#22c55e}.dot-yellow{background:#eab308}.dot-red{background:#ef4444}.dot-gray{background:#6b7280}
</style>
</head>
<body><main>
<div class="top"><div><h1>STAVEN BLUE V1</h1><div class="muted">Control Center</div></div>
<div class="top-right"><button class="btn-secondary" onclick="location.href='/logout'">Logout</button><button onclick="refresh()">Refresh</button></div>
</div>

<div class="grid" id="cards">
<div class="card"><div class="muted">Bot</div><div class="v" id="bot-status">\u2014</div></div>
<div class="card"><div class="muted">Uptime</div><div class="v" id="uptime">\u2014</div></div>
<div class="card"><div class="muted">Session</div><div class="v" id="session">\u2014</div></div>
</div>

<div class="card" style="margin-top:16px">
<h2>Session / Authentication</h2>
<div id="conn-banner" style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:11px;margin-bottom:16px;font-weight:600;font-size:14px;background:#1a1f2e;border:1px solid #252b38">
<span class="status-dot dot-gray" id="conn-dot"></span>
<span id="conn-label">Disconnected</span>
</div>
<div class="session-info">
<div><span class="lbl">Status: </span><span class="val" id="sm-status">\u2014</span></div>
<div><span class="lbl">State: </span><span class="val" id="sm-state">\u2014</span></div>
<div><span class="lbl">Last Check: </span><span class="val" id="sm-last-check">\u2014</span></div>
<div><span class="lbl">Last Failed: </span><span class="val" id="sm-last-fail">\u2014</span></div>
<div><span class="lbl">Created: </span><span class="val" id="sm-created">\u2014</span></div>
<div><span class="lbl">Reference: </span><span class="val" id="sm-ref">\u2014</span></div>
<div><span class="lbl">Last Error: </span><span class="val" id="sm-error" style="color:#ef4444">\u2014</span></div>
</div>

<div class="appstate-area">
<label for="appstate-input">Facebook Session Data</label>
<div style="font-size:12px;color:#6b7280;margin-bottom:8px">Paste your appstate as a <b>JSON array</b> or <b>cookie string</b> (e.g. c_user=...; xs=...)</div>
<textarea id="appstate-input" placeholder='[{"key":"c_user","value":"123456","domain":".facebook.com"},\n {"key":"xs","value":"abc123...","domain":".facebook.com"}]\n\nOr cookie string: c_user=123456; xs=abc123...'></textarea>
</div>

<div class="actions">
<button class="btn-sm btn-green" id="btn-register" onclick="smAction('register')">Connect</button>
<button class="btn-sm btn-blue" id="btn-replace" onclick="smAction('replace')">Replace Session</button>
<button class="btn-sm btn-red" id="btn-remove" onclick="smAction('remove')">Remove Session</button>
<button class="btn-sm btn-orange" id="btn-check" onclick="smAction('check')">Check Status</button>
</div>
<div class="muted status" id="sm-msg"></div>
</div>

<div class="card" style="margin-top:16px"><h2>Security</h2><pre id="security"></pre></div>
</main>

<div class="toast" id="toast"></div>

<script>
var auth='Basic '+btoa('${authB64}');
var H={Authorization:auth,'Content-Type':'application/json'};
var BOT_DOT={connecting:'dot-yellow',connected:'dot-green',disconnected:'dot-gray',error:'dot-red'};
var BOT_LABEL={connecting:'Connecting',connected:'Connected',disconnected:'Offline',error:'Error'};

function showToast(msg,ok){
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast '+(ok?'toast-ok':'toast-err');
  t.style.display='block';
  setTimeout(function(){t.style.display='none'},4000);
}

function fmt(iso){
  if(!iso)return'\u2014';
  try{return new Date(iso).toLocaleString()}catch{return iso}
}

function updateUI(s){
  var bs=s.botStatus||s.status||'disconnected';
  document.getElementById('bot-status').innerHTML='<span class="status-dot '+(BOT_DOT[bs]||'dot-gray')+'"></span>'+(BOT_LABEL[bs]||bs);
  document.getElementById('uptime').textContent=Math.floor((s.uptime||0))+'s';
  document.getElementById('session').textContent=BOT_LABEL[bs]||s.status||'\u2014';
  var cd=document.getElementById('conn-dot');var cl=document.getElementById('conn-label');
  if(cd){cd.className='status-dot '+(BOT_DOT[bs]||'dot-gray');}if(cl){cl.textContent=BOT_LABEL[bs]||bs||'Disconnected';}
  document.getElementById('sm-status').textContent=BOT_LABEL[bs]||s.status||'\u2014';
  document.getElementById('sm-state').textContent=s.configured?'Configured':'Not Configured';
  document.getElementById('sm-last-check').textContent=fmt(s.lastCheck);
  document.getElementById('sm-last-fail').textContent=fmt(s.lastFailedCheck);
  document.getElementById('sm-created').textContent=fmt(s.createdAt);
  document.getElementById('sm-ref').textContent=s.sessionRef||'\u2014';
  document.getElementById('sm-error').textContent=s.error||s.lastBotError||'\u2014';
}

async function refresh(){
  try{
    var a=await fetch('/api/health',{headers:H});
    var s=await fetch('/api/session',{headers:H});
    if(!a.ok||!s.ok){location.reload();return}
    var aj=await a.json(),sj=await s.json();
    sj.uptime=aj.uptime;
    updateUI(sj);
  }catch(e){
    document.getElementById('sm-msg').textContent='Refresh failed';
  }
}

function setLoading(loading){
  var btns=['btn-register','btn-replace','btn-remove','btn-check'];
  btns.forEach(function(id){document.getElementById(id).disabled=loading});
}

async function smAction(action){
  var el=document.getElementById('sm-msg');
  var input=document.getElementById('appstate-input');
  el.textContent='Processing...';
  setLoading(true);

  try{
    var body={};
    if(action==='register'||action==='replace'){
      var val=input.value.trim();
      if(!val){showToast('Paste appstate data first',false);el.textContent='';setLoading(false);return}
      try{body.appState=JSON.parse(val)}catch(e){body.appState=val}
    }

    var r=await fetch('/api/session/'+action,{method:'POST',headers:H,body:JSON.stringify(body)});
    var j=await r.json();

    if(j.ok){
      showToast(action.charAt(0).toUpperCase()+action.slice(1)+' successful',true);
      if(action==='remove')input.value='';
      updateUI(j.state);
      el.textContent='';
    }else{
      showToast(j.error||'Operation failed',false);
      el.textContent=j.error||'Failed';
    }
  }catch(e){
    showToast('Network error',false);
    el.textContent='Network error';
  }finally{
    setLoading(false);
  }
}

document.getElementById('security').textContent=${protectionText};
refresh();
setInterval(refresh,15000);
</script>
</body></html>`);
});

/* ── Start ───────────────────────────────────────────────── */

await loadSessionState();

const port = Number(process.env.PORT || config.port || 3000);
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log(`[STAVEN BLUE V1] listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`[STAVEN BLUE V1] ${signal} received, shutting down`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
