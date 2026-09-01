import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { hasPermission } from './roles.js';
import { addUserToStage, commitPendingRoles } from './roles.js';
import { handleStavenCommand, initStavenPrivate, cleanupStavenPrivate } from './stavenPrivateAutoReply.js';
import { handleSuperAdminCommand, loadSuperAdmins } from './stavenSuperAdminManager.js';
import { handleStavenChat, handleChatReply, loadChatState } from './stavenChat.js';

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
      { listenEvents: true, stopOnSignals: false, selfListen: true }
    );

    botApi = bot.api || bot;

    // Initialize STAVEN PRIVATE AUTO REPLY (DM system) and restore active schedulers
    const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
    await initStavenPrivate(sendFn);

    // Initialize STAVEN SUPER ADMIN MANAGER
    await loadSuperAdmins();

    // Initialize STAVEN CHAT MANAGER
    await loadChatState();

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

      // ── Self-message handling (when selfListen is enabled) ───
      if (isBotMsg) {
        if (body.startsWith('!ستافين')) {
          const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
          const checkPerm = async (uid, level) => hasPermission(uid, level);
          if (await handleStavenChat(event, sendFn, botApi, checkPerm)) return;
          if (await handleSuperAdminCommand(event, sendFn, checkPerm)) return;
          if (handleStavenCommand(event, sendFn)) return;
        }
        // All other bot messages: ignore completely
        return;
      }

      const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
      const checkPerm = async (uid, level) => hasPermission(uid, level);

      // ── STAVEN CHAT MANAGER — must be before other ستافين handlers ─
      if (await handleStavenChat(event, sendFn, botApi, checkPerm)) return;

      // ── STAVEN SUPER ADMIN MANAGER — group/DM commands ─
      if (await handleSuperAdminCommand(event, sendFn, checkPerm)) return;

      // ── STAVEN PRIVATE AUTO REPLY — DM commands ───────
      if (handleStavenCommand(event, sendFn)) return;

      // ── STAVEN CHAT — reply-based menu navigation ────
      if (await handleChatReply(event, sendFn, botApi, checkPerm)) return;

      // ── Command handling ──────────────────────────────
      if (!body.startsWith('!')) return;

      // ── !ستافين تشغيل (Group — old auto-messaging) ────
      // This handles the group-based stop/resume auto-messaging system
      if (body === '!ستافين تشغيل' || body === '!ستافين تشغيل ') {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        // Group auto-messaging: sends "ككك" with smart stop/resume
        log(`Group auto-messaging requested in ${threadID} by ${senderID}`);
        // NOTE: The old group auto-messaging system has been removed.
        // Use !ستافين تشغيل in DM for the private auto-reply system.
        // For groups, this command is a no-op now.
        try { botApi.sendMessage('⚠️ نظام الرسائل التلقائية للغروبات تم إيقافه.\nاستخدم !ستافين تشغيل في المحادثة الخاصة (DM).', threadID); } catch {}
        tryUnsend(messageID);
        return;
      }

      // ── !ستافين ايقاف (Group) ─────────────────────────
      if (body === '!ستافين ايقاف' || body === '!ستافين ايقاف ') {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        try { botApi.sendMessage('⚠️ نظام الرسائل التلقائية للغروبات غير نشط حالياً.', threadID); } catch {}
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
  cleanupStavenPrivate();
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
