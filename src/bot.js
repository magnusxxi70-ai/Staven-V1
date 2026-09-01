import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { hasPermission } from './roles.js';
import { addUserToStage, commitPendingRoles } from './roles.js';

/* ── Bot Core ─────────────────────────────────────────── */

let bot = null;
let botApi = null;

let botState = {
  status: 'disconnected',
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
};

export function getBotState() { return { ...botState }; }
export function getBotApi() { return botApi; }

/* ══════════════════════════════════════════════════════════
   STAVEN AUTO-MESSAGING SYSTEM
   ══════════════════════════════════════════════════════════ */

const AUTO_MSG_FILE = path.resolve('data/auto-messaging.json');
const AUTO_MSG = 'ككك';
const AUTO_INTERVAL = 1; // 1 second
const MAX_CONSECUTIVE = 2; // send 2 messages then pause

// Per-thread state: { enabled, consecutive, paused, timer, lastSentAt }
const stavenState = {};

/* ── Helpers ──────────────────────────────────────────── */

function box(title, lines) {
  const bar = '─'.repeat(32);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

async function tryUnsend(messageID) {
  if (!messageID || !botApi) return;
  try {
    if (typeof botApi.unsendMessage === 'function') await botApi.unsendMessage(messageID);
    else if (typeof botApi.unsend === 'function') await botApi.unsend(messageID);
  } catch {}
}

function log(msg) { console.log(`[STAVEN] ${msg}`); }

/* ── Core Send Loop ───────────────────────────────────── */

function sendLoop(threadID) {
  const state = stavenState[threadID];
  if (!state || !state.enabled) return;

  // Clear any existing timer first (prevent duplicates)
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }

  state.timer = setTimeout(async () => {
    // Re-check state inside callback (may have been stopped)
    const s = stavenState[threadID];
    if (!s || !s.enabled) return;

    try {
      await botApi.sendMessage(AUTO_MSG, threadID);
      s.consecutive++;
      s.lastSentAt = Date.now();
    } catch (err) {
      log(`Send failed in ${threadID}: ${err?.message}`);
    }

    // Smart stop: after MAX_CONSECUTIVE messages, pause
    if (s.consecutive >= MAX_CONSECUTIVE) {
      s.paused = true;
      s.enabled = false; // disable the loop, keep state for resume
      log(`Paused in ${threadID} after ${s.consecutive} messages`);
      saveState().catch(() => {});
      return;
    }

    // Continue loop
    sendLoop(threadID);
  }, AUTO_INTERVAL * 1000);

  if (state.timer?.unref) state.timer?.unref();
}

/* ── Start ────────────────────────────────────────────── */

function startStaven(threadID) {
  // Clean up any existing state for this thread
  clearThread(threadID);

  stavenState[threadID] = {
    enabled: true,
    consecutive: 0,
    paused: false,
    timer: null,
    lastSentAt: null,
    startedAt: Date.now(),
  };

  log(`Started in ${threadID}`);
  sendLoop(threadID);
  saveState().catch(() => {});
}

/* ── Resume (on human message) ────────────────────────── */

function resumeStaven(threadID) {
  const s = stavenState[threadID];
  if (!s) return;
  // Must be paused (was running but stopped after 2 messages)
  if (!s.paused) return;

  s.paused = false;
  s.enabled = true;
  s.consecutive = 0;
  log(`Resumed in ${threadID}`);
  sendLoop(threadID);
  saveState().catch(() => {});
}

/* ── Stop ─────────────────────────────────────────────── */

function stopStaven(threadID) {
  const s = stavenState[threadID];
  if (!s) return false;

  clearThread(threadID);
  delete stavenState[threadID];
  log(`Stopped in ${threadID}`);
  saveState().catch(() => {});
  return true;
}

/* ── Cleanup ──────────────────────────────────────────── */

function clearThread(threadID) {
  const s = stavenState[threadID];
  if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
}

function cleanupAll() {
  for (const tid of Object.keys(stavenState)) clearThread(tid);
}

/* ── Persistence ──────────────────────────────────────── */

async function saveState() {
  try {
    await fs.mkdir(path.dirname(AUTO_MSG_FILE), { recursive: true });
    const out = {};
    for (const [tid, s] of Object.entries(stavenState)) {
      out[tid] = { enabled: s.enabled, consecutive: s.consecutive, paused: s.paused };
    }
    await fs.writeFile(AUTO_MSG_FILE, JSON.stringify(out, null, 2));
  } catch {}
}

async function loadState() {
  try {
    const saved = JSON.parse(await fs.readFile(AUTO_MSG_FILE, 'utf8'));
    for (const [tid, data] of Object.entries(saved)) {
      // On restart, don't auto-resume — just note it was active
      // User must re-trigger with !ستافين تشغيل
      log(`Found saved state for ${tid} (not auto-resuming)`);
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════
   BOT STARTUP
   ══════════════════════════════════════════════════════════ */

export async function startBot(appStateArray) {
  if (bot) { try { await stopBot(); } catch {} }

  botState.status = 'connecting';
  botState.lastError = null;

  try {
    bot = await createMessengerBot(
      { appState: appStateArray },
      { listenEvents: true, stopOnSignals: false }
    );

    botApi = bot.api || bot;

    // Load saved state (informational only, no auto-resume)
    await loadState();

    bot.on('error', (err) => {
      console.error('[BOT] Error:', err?.message || err);
      botState.status = 'error';
      botState.lastError = new Date().toISOString();
      botState.lastDisconnected = new Date().toISOString();
    });

    bot.on('messageCreate', async (event) => {
      const body = String(event?.body || '').trim();
      const threadID = String(event?.threadID || '');
      const senderID = String(event?.senderID || '');
      const messageID = String(event?.messageID || '');
      if (!threadID) return;

      // ── Identify bot messages ─────────────────────────
      const botID = String(event?.botID || '');
      const isBotMsg = senderID === '0' || senderID === botID;

      // ── Human message detection for Staven resume ─────
      // Any non-bot, non-command message resumes the paused system
      if (!isBotMsg && body && !body.startsWith('!')) {
        resumeStaven(threadID);
      }

      // ── Command handling ──────────────────────────────
      if (!body.startsWith('!')) return;

      // ── !ستافين (help) ─────────────────────────────────
      if (body === '!ستافين' || body === '!ستافين ') {
        const msg = box('⚡ Staven Blue V1', [
          '⚙️ نظام الرسائل التلقائية',
          '',
          '!ستافين تشغيل — تشغيل النظام',
          '!ستافين ايقاف — إيقاف النظام',
          '',
          '📌 كيف يعمل:',
          'يرسل "ككك" كل ثانية.',
          'بعد رسالتين يتوقف مؤقتاً.',
          'عند تحدث عضو يستأنف تلقائياً.',
          '',
          '👑 المطور: Magnus',
        ]);
        try { botApi.sendMessage(msg, threadID); } catch {}
        return;
      }

      // ── !ستافين ايقاف ──────────────────────────────────
      if (body === '!ستافين ايقاف' || body === '!ستافين ايقاف ') {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        const stopped = stopStaven(threadID);
        const msg = box('⚡ Staven Blue V1', [
          stopped ? '🛑 تم إيقاف الإرسال التلقائي.' : '⚠️ لا يوجد نظام تلقائي نشط.',
          '',
          '🤖 البوت: Staven Blue V1',
          '👑 المطور: Magnus',
          '⚙️ الحالة: متوقف',
        ]);
        try { botApi.sendMessage(msg, threadID); } catch {}
        tryUnsend(messageID);
        return;
      }

      // ── !ستافين تشغيل ──────────────────────────────────
      if (body === '!ستافين تشغيل' || body === '!ستافين تشغيل ') {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        startStaven(threadID);

        const msg = box('⚡ Staven Blue V1', [
          '✅ تم تشغيل النظام بنجاح',
          '',
          '📝 الرسالة: ككك',
          '⏱️ الفاصل: كل ثانية',
          '⚙️ طبيعة النظام: إرسال تلقائي متكرر',
          '',
          '📌 يرسل رسالتين ثم يتوقف.',
          'عند تحدث عضو يستأنف تلقائياً.',
          '',
          '👑 المطور: Magnus',
        ]);
        try { botApi.sendMessage(msg, threadID); } catch {}
        tryUnsend(messageID);
        return;
      }

      // ── !uptime ──────────────────────────────────────
      const cmd = body.split(/\s+/)[0].toLowerCase();
      if (cmd === '!uptime') {
        const totalSec = Math.floor(process.uptime());
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;

        const bar = '─'.repeat(32);
        const msg = [
          `╭${bar}╮`,
          '│ ⚡ STAVEN BLUE V1',
          '│',
          '│ ⏱️ مدة التشغيل:',
          `│ 📅 الأيام: ${days}`,
          `│ 🕐 الساعات: ${hours}`,
          `│ ⏳ الدقائق: ${minutes}`,
          `│ ⚡ الثواني: ${seconds}`,
          '│',
          '│ 🤖 النظام: Staven Blue V1',
          '│ 👑 المطور: Magnus',
          '│',
          `╰${bar}╯`,
        ].join('\n');

        try { botApi.sendMessage(msg, threadID); } catch {}
      }
    });

    botState.status = 'connected';
    botState.lastConnected = new Date().toISOString();
    console.log('[BOT] Connected to Facebook Messenger');
  } catch (err) {
    bot = null;
    botApi = null;
    botState.status = 'error';
    botState.lastError = new Date().toISOString();
    console.error('[BOT] Failed to start:', err?.message || err);
    throw err;
  }
}

export async function stopBot() {
  cleanupAll();
  if (bot) {
    try {
      if (typeof bot.stop === 'function') bot.stop();
      else if (typeof bot.stopListening === 'function') bot.stopListening();
      else if (typeof bot.disconnect === 'function') bot.disconnect();
      else if (bot.api && typeof bot.api.stopListening === 'function') bot.api.stopListening();
      else if (bot.api && typeof bot.api.logout === 'function') bot.api.logout();
    } catch {}
    bot = null;
    botApi = null;
  }
  botState.status = 'disconnected';
  botState.lastDisconnected = new Date().toISOString();
  console.log('[BOT] Stopped');
}
