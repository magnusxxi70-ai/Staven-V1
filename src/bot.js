import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { hasPermission, getUserRole, getRoles } from './roles.js';
import { addUserToStage, commitPendingRoles } from './roles.js';

let bot = null;
let botApi = null;

let botState = {
  status: 'disconnected', // connecting | connected | disconnected | error
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
};

export function getBotState() { return { ...botState }; }
export function getBotApi() { return botApi; }

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
      if (!threadID || !body.startsWith('!')) return;

      // ── !ستافين اضافة ادمن ──────────────────────────
      if (body === '!ستافين اضافة ادمن' || body === '!ستافين اضافة ادمن ') {
        if (!hasPermission(senderID, 'superAdmin')) {
          try { botApi.sendMessage('\u274C هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID); } catch {}
          return;
        }

        const targetID = event?.messageReply?.senderID ? String(event.messageReply.senderID) : null;
        if (!targetID) {
          try { botApi.sendMessage('\u274C يجب الرد على رسالة الشخص الذي تريد إضافته كـ Super Admin.', threadID); } catch {}
          return;
        }

        if (targetID === senderID) {
          try { botApi.sendMessage('\u274C لا يمكنك إضافة نفسك كـ Super Admin.', threadID); } catch {}
          return;
        }

        const existing = getUserRole(targetID);
        if (existing) {
          try { botApi.sendMessage(`\u274C هذا الشخص بالفعل صلاحيته: ${existing}`, threadID); } catch {}
          return;
        }

        const r = addUserToStage(targetID, 'superAdmin');
        if (!r.ok) {
          try { botApi.sendMessage(`\u274C خطأ: ${r.error}`, threadID); } catch {}
          return;
        }

        await commitPendingRoles();

        const bar = '\u2500'.repeat(32);
        const msg = [
          `\u256D\u2500\u3010 \U0001F451 STAVEN BLUE V1 \u3011\u2500\u256E`,
          '\u2502',
          '\u2502 \u2705 \u062A\u0645 \u0625\u0636\u0627\u0641\u0629 Super Admin \u0628\u0646\u062C\u0627\u062D',
          '\u2502',
          `\u2502 \U0001F464 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645: ${targetID}`,
          `\u2502 \U0001F194 ID: ${targetID}`,
          '\u2502 \U0001F6E1\uFE0F \u0627\u0644\u0635\u0644\u0627\u062D\u064A\u0629: Super Admin',
          '\u2502',
          '\u2502 \u26A1 \u0627\u0635\u0628\u062D\u062A \u0644\u0647 \u0635\u0644\u0627\u062D\u064A\u0629 Super Admin',
          '\u2502',
          `\u2570${bar}\u256F`,
          '\U0001F451 Developer: Magnus',
        ].join('\n');

        try { botApi.sendMessage(msg, threadID); } catch {}
        return;
      }

      const cmd = body.split(/\s+/)[0].toLowerCase();

      // ── !uptime ──────────────────────────────────────
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
