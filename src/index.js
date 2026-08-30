import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { loadSessionState, getSessionState, registerSessionSubmission } from './session.js';
import { protections, redact } from './security.js';

process.on('uncaughtException', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));
process.on('unhandledRejection', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '64kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="STAVEN BLUE V1"');
    return res.status(401).send('Authentication required');
  }
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return res.status(401).end();
  }
  const i = decoded.indexOf(':');
  if (i < 0) return res.status(401).end();
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  if (user !== config.dashboardUser || pass !== config.dashboardPassword) {
    res.set('WWW-Authenticate', 'Basic realm="STAVEN BLUE V1"');
    return res.status(401).end();
  }
  next();
}

app.get('/health', (_req, res) => res.json({
  ok: true,
  name: 'STAVEN BLUE V1',
  uptime: process.uptime()
}));

app.get('/api/health', auth, (_req, res) => res.json({
  ok: true,
  name: 'STAVEN BLUE V1',
  uptime: process.uptime()
}));

app.get('/api/session', auth, (_req, res) => res.json(getSessionState()));

app.post('/api/session/register', auth, async (_req, res) => {
  const result = await registerSessionSubmission();
  res.json({ ok: true, state: result });
});

app.get('/', auth, (_req, res) => {
  const protectionText = JSON.stringify(protections.map(x => '✓ ' + x).join('\n'));
  const user = JSON.stringify(config.dashboardUser);
  const pass = JSON.stringify(config.dashboardPassword);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 Control Center</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
h1{margin:0;font-size:34px}.muted{color:#929caf}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
.card{background:#131720;border:1px solid #252b38;border-radius:18px;padding:20px;box-shadow:0 10px 35px #0003}
.v{font-size:27px;font-weight:750;margin-top:8px}.pill{display:inline-block;padding:7px 10px;border-radius:999px;background:#1c2430}
button{padding:11px 15px;border:0;border-radius:11px;font-weight:700;cursor:pointer}
pre{white-space:pre-wrap;line-height:1.65}.status{margin-top:12px}
</style>
</head>
<body><main>
<div class="top"><div><h1>STAVEN BLUE V1</h1><div class="muted">Control Center</div></div><button onclick="refresh()">Refresh</button></div>
<div class="grid">
<div class="card"><div class="muted">Bot</div><div class="v">Online</div></div>
<div class="card"><div class="muted">Uptime</div><div class="v" id="uptime">—</div></div>
<div class="card"><div class="muted">Session</div><div class="v" id="session">—</div></div>
<div class="card"><div class="muted">Session</div><button onclick="register()">Register session state</button><div class="muted status" id="msg"></div></div>
</div>
<div class="card" style="margin-top:16px"><h2>Security</h2><pre id="security"></pre></div>
</main>
<script>
const auth='Basic '+btoa(${user}+':'+${pass});
async function refresh(){
  const h={Authorization:auth};
  const a=await fetch('/api/health',{headers:h});
  const s=await fetch('/api/session',{headers:h});
  if(!a.ok||!s.ok){location.reload();return}
  const aj=await a.json(), sj=await s.json();
  document.getElementById('uptime').textContent=Math.floor(aj.uptime)+'s';
  document.getElementById('session').textContent=sj.status;
}
async function register(){
  const r=await fetch('/api/session/register',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:'{}'});
  document.getElementById('msg').textContent=r.ok?'Saved':'Failed';
  refresh();
}
document.getElementById('security').textContent=${protectionText};
refresh();
setInterval(refresh,15000);
</script>
</body></html>`);
});

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
