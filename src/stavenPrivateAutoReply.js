"use strict";

/**
 * ══════════════════════════════════════════════════════════
 * STAVEN PRIVATE AUTO REPLY V1
 * Developer: Magnus
 * Bot: Staven Blue V1
 * ══════════════════════════════════════════════════════════
 *
 * Independent DM auto-reply system.
 * - DM only (not groups)
 * - Continuous auto-reply (NO auto-stop — runs until !ستافين ايقاف)
 * - Per-thread independent state
 * - Persistent across restarts
 * - Permission-gated: only Owner + Admins receive auto-replies
 * - Dedup: each message processed only once
 * - Commands: !ستافين / !ستافين تشغيل / !ستافين ايقاف / !ستافين حالة
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ══════════════════════════════════════════════════════════
   CONFIGURATION — Edit these values easily
   ══════════════════════════════════════════════════════════ */

/** Auto-reply message sent continuously */
const AUTO_MESSAGE = "ككك";

/** Interval between auto-replies in milliseconds (1000 = 1 second) */
const AUTO_REPLY_INTERVAL = 1000;

/** Data file path for persistence */
const DATA_FILE = path.resolve('data/stavenPrivateAutoReply.json');

/* ══════════════════════════════════════════════════════════
   STATE MANAGEMENT
   ══════════════════════════════════════════════════════════ */

// Per-thread state: { active: boolean }
const state = {};

// Per-thread timers (not persisted — recreated on load)
const timers = {};

// Single reference for the send function (set during init)
let _sendFn = null;

/* ══════════════════════════════════════════════════════════
   MESSAGE DEDUPLICATION
   ══════════════════════════════════════════════════════════ */

const processedMsgIds = new Set();
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a message has already been processed.
 */
export function isMessageProcessed(messageID) {
  if (!messageID) return false;
  return processedMsgIds.has(messageID);
}

/**
 * Mark a message as processed. Auto-cleans after TTL.
 */
export function markMessageProcessed(messageID) {
  if (!messageID) return;
  processedMsgIds.add(messageID);
  setTimeout(() => { processedMsgIds.delete(messageID); }, DEDUP_TTL);
}

/* ══════════════════════════════════════════════════════════
   PERMISSION CHECK
   ══════════════════════════════════════════════════════════ */

let _checkPerm = null;

/**
 * Set the permission check function.
 * @param {Function} fn - async (userId, level) => boolean
 */
export function setPermissionChecker(fn) {
  _checkPerm = fn;
}

/**
 * Check if user is allowed (Owner / Super Admin / Admin).
 */
async function isStavenAllowed(userId) {
  if (!userId) return false;
  if (_checkPerm) {
    return await _checkPerm(userId, 'admin');
  }
  return false;
}

/* ══════════════════════════════════════════════════════════
   PERSISTENCE
   ══════════════════════════════════════════════════════════ */

async function saveData() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const out = {};
    for (const [tid, s] of Object.entries(state)) {
      out[tid] = { active: s.active };
    }
    await fs.writeFile(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('[STAVEN-PRIVATE] Save failed:', err?.message);
  }
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const saved = JSON.parse(raw);
    for (const [tid, data] of Object.entries(saved)) {
      state[tid] = { active: !!data.active };
    }
  } catch {
    // No data file yet
  }
}

/* ══════════════════════════════════════════════════════════
   TIMER / SCHEDULER MANAGEMENT
   ══════════════════════════════════════════════════════════ */

function startScheduler(threadID, sendFn) {
  // CRITICAL: Prevent duplicate timers
  if (timers[threadID]) return;

  const loop = async () => {
    if (!state[threadID]?.active) {
      delete timers[threadID];
      return;
    }

    try {
      await sendFn(AUTO_MESSAGE, threadID);
    } catch (err) {
      console.error(`[STAVEN-PRIVATE] Send failed in ${threadID}:`, err?.message);
    }

    if (state[threadID]?.active) {
      timers[threadID] = setTimeout(loop, AUTO_REPLY_INTERVAL);
      if (timers[threadID]?.unref) timers[threadID].unref();
    } else {
      delete timers[threadID];
    }
  };

  timers[threadID] = setTimeout(loop, AUTO_REPLY_INTERVAL);
  if (timers[threadID]?.unref) timers[threadID].unref();
}

function stopScheduler(threadID) {
  if (timers[threadID]) {
    clearTimeout(timers[threadID]);
    delete timers[threadID];
  }
}

function cleanupAll() {
  for (const tid of Object.keys(timers)) {
    clearTimeout(timers[tid]);
    delete timers[tid];
  }
}

/* ══════════════════════════════════════════════════════════
   DM DETECTION
   ══════════════════════════════════════════════════════════ */

function isDM(event, senderID, threadID) {
  if (event?.isGroup === true) return false;
  if (event?.threadType === 'group') return false;
  if (senderID === '0') return true; // self-messages are DM
  return threadID === senderID;
}

/* ══════════════════════════════════════════════════════════
   COMMAND HANDLER
   ══════════════════════════════════════════════════════════ */

function box(title, lines) {
  const bar = '─'.repeat(36);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

/**
 * Handle a STAVEN command. Now async for permission checks.
 * @param {object} event - FCA messageCreate event
 * @param {Function} sendFn - async (msg, threadID) => void
 * @param {object} opts - { isBotMsg: boolean, botID: string, checkPerm: Function }
 * @returns {boolean} true if this system handled the command
 */
export async function handleStavenCommand(event, sendFn, opts = {}) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');
  const messageID = String(event?.messageID || '');

  if (!body.startsWith('!ستافين')) return false;

  // DM detection for non-bot messages
  if (!opts.isBotMsg) {
    if (!isDM(event, senderID, threadID)) return false;
  }

  const sub = body.slice('!ستافين'.length).trim();

  // ── !ستافين (bare — show help) ─────────────────────
  if (sub === '') {
    const msg = box('⚡ STAVEN PRIVATE AUTO REPLY V1', [
      '⚙️ نظام الرد التلقائي',
      '',
      '🔧 الأوامر:',
      '!ستافين تشغيل — تشغيل النظام',
      '!ستافين ايقاف — إيقاف النظام',
      '!ستافين حالة — عرض الحالة',
      '',
      '📌 ملاحظة:',
      'هذا النظام يعمل في المحادثات',
      'الخاصة (DM) فقط.',
      'يرد فقط على Owner + Admins.',
      '',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين تشغيل ──────────────────────────────────
  if (sub === 'تشغيل') {

    // Permission check — bot owner bypasses
    if (!opts.isBotMsg) {
      const checkFn = opts.checkPerm || _checkPerm;
      if (checkFn) {
        const allowed = await checkFn(senderID, 'admin');
        if (!allowed) {
          sendFn('❌ هذا الأمر متاح فقط لـ Owner / Admin.', threadID).catch(() => {});
          return true;
        }
      }
    }

    // Already active? Don't create duplicate instance
    if (state[threadID]?.active) {
      const msg = box('⚡ STAVEN PRIVATE AUTO REPLY V1', [
        '⚡ النظام يعمل بالفعل',
        '📍 النوع: محادثة خاصة',
        '🤖 البوت: Staven Blue V1',
        '👑 المطور: Magnus',
        '🟢 الحالة: يعمل',
        `🆔 Thread ID: ${threadID}`,
      ]);
      sendFn(msg, threadID).catch(() => {});
      return true;
    }

    // Activate
    state[threadID] = { active: true };

    // Start scheduler only if no timer exists
    if (!timers[threadID] && _sendFn) {
      startScheduler(threadID, _sendFn);
    }

    saveData().catch(() => {});

    const msg = box('⚡ STAVEN PRIVATE AUTO REPLY V1', [
      '✅ تم تشغيل النظام بنجاح',
      '📍 النوع: محادثة خاصة',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
      '🟢 الحالة: يعمل',
      `🆔 Thread ID: ${threadID}`,
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين ايقاف ──────────────────────────────────
  if (sub === 'ايقاف') {

    // Permission check — bot owner bypasses
    if (!opts.isBotMsg) {
      const checkFn = opts.checkPerm || _checkPerm;
      if (checkFn) {
        const allowed = await checkFn(senderID, 'admin');
        if (!allowed) {
          sendFn('❌ هذا الأمر متاح فقط لـ Owner / Admin.', threadID).catch(() => {});
          return true;
        }
      }
    }

    const wasActive = state[threadID]?.active;

    // Complete cleanup
    state[threadID] = { active: false };
    stopScheduler(threadID);
    delete state[threadID];

    saveData().catch(() => {});

    const msg = box('⚡ STAVEN PRIVATE AUTO REPLY V1', [
      wasActive ? '🛑 تم إيقاف النظام' : '⚠️ النظام غير نشط حالياً',
      '📍 النوع: محادثة خاصة',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
      '🔴 الحالة: متوقف',
      `🆔 Thread ID: ${threadID}`,
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين حالة ────────────────────────────────────
  if (sub === 'حالة') {
    const isActive = !!state[threadID]?.active;
    const msg = box('⚡ STAVEN PRIVATE AUTO REPLY V1', [
      '📍 النوع: محادثة خاصة',
      isActive ? '🟢 الحالة: يعمل' : '🔴 الحالة: متوقف',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
      `🆔 Thread ID: ${threadID}`,
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // Not a STAVEN PRIVATE command (e.g., !ستافين شات, !ستافين اضافة ادمن)
  return false;
}

/* ══════════════════════════════════════════════════════════
   INITIALIZATION
   ══════════════════════════════════════════════════════════ */

/**
 * Initialize the system: load data, set up permissions, restore active schedulers.
 * @param {Function} sendFn - async (msg, threadID) => void
 * @param {Function} getUserRoleFn - from roles.js (userId => role|null)
 */
export async function initStavenPrivate(sendFn, getUserRoleFn) {
  _sendFn = sendFn;

  // Set up async permission checker from roles.js
  if (getUserRoleFn) {
    const ROLE_LEVEL = { admin: 1, superAdmin: 2, owner: 3 };
    _checkPerm = async (userId, minLevel) => {
      const role = getUserRoleFn(userId);
      if (!role) return false;
      return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minLevel] || 0);
    };
  }

  await loadData();

  // Restore active schedulers
  let restored = 0;
  for (const [tid, s] of Object.entries(state)) {
    if (s.active && !timers[tid] && _sendFn) {
      startScheduler(tid, _sendFn);
      restored++;
    }
  }

  if (restored > 0) {
    console.log(`[STAVEN-PRIVATE] Restored ${restored} active DM scheduler(s)`);
  }
}

/**
 * Cleanup all timers. Call on bot shutdown.
 */
export function cleanupStavenPrivate() {
  cleanupAll();
}
