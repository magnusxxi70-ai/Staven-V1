import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { hasPermission, getUserRole } from './roles.js';
import {
  handleStavenCommand,
  initStavenPrivate,
  cleanupStavenPrivate,
  isMessageProcessed,
  markMessageProcessed,
} from './stavenPrivateAutoReply.js';
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

    // Cache the bot's own ID for self-message detection
    let cachedBotID = '';
    try {
      if (typeof botApi.getCurrentUserID === 'function') {
        cachedBotID = String(await botApi.getCurrentUserID());
      }
    } catch {}
    const botID = cachedBotID;

    console.log(`[BOT] Bot ID: ${botID || '(unknown)'}`);

    // Initialize STAVEN PRIVATE AUTO REPLY
    const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
    await initStavenPrivate(sendFn, getUserRole);

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

      // ════════════════════════════════════════════════════════
      // DEDUPLICATION — prevent processing same message twice
      // ════════════════════════════════════════════════════════
      if (messageID && isMessageProcessed(messageID)) return;
      if (messageID) markMessageProcessed(messageID);

      // ════════════════════════════════════════════════════════
      // IDENTIFY MESSAGE SOURCE
      // ════════════════════════════════════════════════════════
      const isBotMsg = senderID === '0' || senderID === botID;

      const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
      const checkPerm = async (uid, level) => {
        if (botID && uid === botID) return true;
        return hasPermission(uid, level);
      };

      // ════════════════════════════════════════════════════════
      // BOT MESSAGE HANDLING (selfListen: true)
      // ════════════════════════════════════════════════════════
      if (isBotMsg) {
        // Bot's own messages: only handle STAVEN commands, ignore everything else
        // This prevents loops from auto-reply messages
        if (body.startsWith('!ستافين')) {
          if (await handleStavenCommand(event, sendFn, { isBotMsg: true, botID })) return;
          if (await handleStavenChat(event, sendFn, botApi, checkPerm)) return;
          if (await handleSuperAdminCommand(event, sendFn, checkPerm)) return;
        }
        // All other bot messages (including auto-reply output) → ignore
        return;
      }

      // ════════════════════════════════════════════════════════
      // HUMAN MESSAGE HANDLING
      // ════════════════════════════════════════════════════════

      // 1. Try STAVEN COMMANDS first (highest priority for !ستافين)
      if (body.startsWith('!ستافين')) {
        if (await handleStavenCommand(event, sendFn, { isBotMsg: false, botID })) return;
        if (await handleStavenChat(event, sendFn, botApi, checkPerm)) return;
        if (await handleSuperAdminCommand(event, sendFn, checkPerm)) return;
      }

      // 2. Try STAVEN CHAT reply-based menu navigation (no prefix required)
      if (await handleChatReply(event, sendFn, botApi, checkPerm)) return;

      // 3. Try other commands
      if (!body.startsWith('!')) return;

      // ── !uptime ──────────────────────────────────────
      const cmd = body.split(/\s+/)[0].toLowerCase();
      if (cmd === '!uptime') {
        if (!await checkPerm(senderID, 'admin')) return;

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
