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

/* ── Auto-Messaging State ─────────────────────────────── */

const AUTO_MSG_FILE = path.resolve('data/auto-messaging.json');

// Per-thread state: { threadID: { message, interval, sentCount, active, paused, timer } }
const autoStates = {};

/**
 * Parse duration string to seconds.
 * Supports: 1ث, 2ث, 5ث, 10ث, 30ث, 60ث, 1s, 2s, 5s, 10s, 30s, 60s, or plain numbers.
 */
function parseDuration(raw) {
  if (!raw) return null;
  const cleaned = raw.trim();
  // Match: digits + ث (Arabic tha)
  const mArabic = cleaned.match(/^(\d+)[\u0629\u062B]?$/);
  if (mArabic) return parseInt(mArabic[1], 10);
  // Match: digits + s (English)
  const mEnglish = cleaned.match(/^(\d+)s$/i);
  if (mEnglish) return parseInt(mEnglish[1], 10);
  // Match: digits only
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return null;
}

/**
 * Unsend a message if possible.
 */
async function tryUnsend(messageID) {
  if (!messageID || !botApi) return;
  try {
    if (typeof botApi.unsendMessage === 'function') {
      await botApi.unsendMessage(messageID);
    } else if (typeof botApi.unsend === 'function') {
      await botApi.unsend(messageID);
    }
  } catch {}
}

/**
 * Schedule next auto-send for a thread.
 */
function scheduleNext(threadID) {
  const state = autoStates[threadID];
  if (!state || !state.active) return;

  state.timer = setTimeout(async () => {
    if (!state.active || !botApi) return;

    try {
      await botApi.sendMessage(state.message, threadID);
      state.sentCount++;
    } catch (err) {
      console.error(`[AUTO-MSG] Send failed in ${threadID}:`, err?.message);
    }

    // Smart stop: after 2 messages, pause
    if (state.sentCount >= 2) {
      state.active = false;
      state.paused = true;
      console.log(`[AUTO-MSG] Paused in ${threadID} after 2 messages`);
      await saveAutoState();
      return;
    }

    // Continue sending
    scheduleNext(threadID);
  }, state.interval * 1000);

  if (state.timer?.unref) state.timer.unref();
}

/**
 * Resume auto-messaging for a thread (called on human message).
 */
function resumeAuto(threadID) {
  const state = autoStates[threadID];
  if (!state || !state.active || !state.paused) return;

  state.active = true;
  state.paused = false;
  state.sentCount = 0;
  console.log(`[AUTO-MSG] Resumed in ${threadID}`);
  scheduleNext(threadID);
  saveAutoState().catch(() => {});
}

/**
 * Stop auto-messaging for a thread.
 */
function stopAuto(threadID) {
  const state = autoStates[threadID];
  if (!state) return false;

  if (state.timer) clearTimeout(state.timer);
  delete autoStates[threadID];
  console.log(`[AUTO-MSG] Stopped in ${threadID}`);
  saveAutoState().catch(() => {});
  return true;
}

/**
 * Start auto-messaging for a thread.
 */
async function startAuto(threadID, message, interval) {
  // Stop existing timer if any
  if (autoStates[threadID]?.timer) clearTimeout(autoStates[threadID].timer);

  autoStates[threadID] = {
    message,
    interval,
    sentCount: 0,
    active: true,
    paused: false,
    startedAt: Date.now(),
  };

  console.log(`[AUTO-MSG] Started in ${threadID}: "${message}" every ${interval}s`);
  scheduleNext(threadID);
  await saveAutoState();
}

/* ── Persistence ──────────────────────────────────────── */

async function saveAutoState() {
  try {
    await fs.mkdir(path.dirname(AUTO_MSG_FILE), { recursive: true });
    const saveData = {};
    for (const [tid, s] of Object.entries(autoStates)) {
      saveData[tid] = {
        message: s.message,
        interval: s.interval,
        sentCount: s.sentCount,
        active: s.active,
        paused: s.paused,
        startedAt: s.startedAt,
      };
    }
    await fs.writeFile(AUTO_MSG_FILE, JSON.stringify(saveData, null, 2));
  } catch {}
}

async function loadAutoState() {
  try {
    const saved = JSON.parse(await fs.readFile(AUTO_MSG_FILE, 'utf8'));
    for (const [tid, data] of Object.entries(saved)) {
      if (data.active || data.paused) {
        autoStates[tid] = { ...data, timer: null };
        if (data.active && !data.paused) {
          scheduleNext(tid);
          console.log(`[AUTO-MSG] Restored active auto-msg in ${tid}`);
        }
      }
    }
  } catch {}
}

function cleanupAutoTimers() {
  for (const s of Object.values(autoStates)) {
    if (s.timer) clearTimeout(s.timer);
  }
}

/* ── Command Helpers ──────────────────────────────────── */

function box(title, lines) {
  const bar = '─'.repeat(32);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

/* ── Start Bot ────────────────────────────────────────── */

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

    // Load saved auto-messaging states
    await loadAutoState();

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

      // ── Monitor human messages to resume auto-messaging ──
      if (body && senderID) {
        const botID = String(event?.botID || '');
        const isBot = senderID === '0' || senderID === botID;
        // Only non-bot, non-command messages count as human interaction
        if (!isBot && !body.startsWith('!') && autoStates[threadID]?.paused) {
          resumeAuto(threadID);
        }
      }

      if (!body.startsWith('!')) return;

      // ── !ستافين (help) ─────────────────────────────────
      if (body === '!ستافين' || body === '!ستافين ') {
        const msg = box('STAVEN BLUE V1', [
          '⚙️ نظام الرسائل التلقائية',
          '',
          '!ستافين تشغيل [الرسالة] [المدة]',
          '',
          'مثال:',
          '!ستافين تشغيل ككك 1ث',
          '!ستافين تشغيل هلا 5s',
          '',
          '🛑 للإيقاف:',
          '!ستافين ايقاف',
          '',
          '📌 النظام:',
          'يرسل رسالتين تلقائيتين، ثم يتوقف',
          'حتىتحدث أحد أعضاء الغروب،',
          'وبعدها يستأنف ويرسل رسالتين من جديد.',
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

        const stopped = stopAuto(threadID);
        const msg = box('STAVEN BLUE V1', [
          stopped ? '🛑 تم إيقاف النظام التلقائي.' : '⚠️ لا يوجد نظام تلقائي نشط.',
          '',
          '⚙️ الحالة: متوقف',
          '👑 المطور: Magnus',
        ]);
        try { botApi.sendMessage(msg, threadID); } catch {}
        // Delete the command message
        tryUnsend(messageID);
        return;
      }

      // ── !ستافين تشغيل [message] [duration] ─────────────
      if (body.startsWith('!ستافين تشغيل')) {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        const args = body.slice('!ستافين تشغيل'.length).trim();
        if (!args) {
          try { botApi.sendMessage('❌ يرجى كتابة الرسالة والمدة.\nمثال: !ستافين تشغيل ككك 1ث', threadID); } catch {}
          return;
        }

        // Extract duration (last token)
        const parts = args.split(/\s+/);
        const durationRaw = parts[parts.length - 1];
        const interval = parseDuration(durationRaw);

        if (!interval || interval < 1) {
          try { botApi.sendMessage('❌ المدة غير صحيحة. استخدم: 1ث, 2s, 5ث, 10s, إلخ.', threadID); } catch {}
          return;
        }

        // Message is everything except the last token
        const message = parts.slice(0, -1).join(' ').trim();
        if (!message) {
          try { botApi.sendMessage('❌ يرجى كتابة الرسالة.\nمثال: !ستافين تشغيل ككك 1ث', threadID); } catch {}
          return;
        }

        await startAuto(threadID, message, interval);

        const msg = box('STAVEN BLUE V1', [
          '✅ تم تشغيل النظام بنجاح',
          '',
          `📝 الرسالة: ${message}`,
          `⏱️ الفاصل: ${interval} ثانية`,
          '⚙️ طبيعة الأمر: إرسال تلقائي متكرر',
          '',
          '👑 المطور: Magnus',
        ]);
        try { botApi.sendMessage(msg, threadID); } catch {}
        // Delete the command message
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
  cleanupAutoTimers();
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
