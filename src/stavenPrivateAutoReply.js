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
 * - Continuous auto-reply (no stopping after messages)
 * - Per-thread independent state
 * - Persistent across restarts
 * - Commands: !ستافين تشغيل / !ستافين ايقاف / !ستافين حالة
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
    // No data file yet — that's fine
  }
}

/* ══════════════════════════════════════════════════════════
   TIMER / SCHEDULER MANAGEMENT
   ══════════════════════════════════════════════════════════ */

function startScheduler(threadID, sendFn) {
  // Prevent duplicate timers
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

    // Schedule next — only if still active
    if (state[threadID]?.active) {
      timers[threadID] = setTimeout(loop, AUTO_REPLY_INTERVAL);
      if (timers[threadID]?.unref) timers[threadID].unref();
    } else {
      delete timers[threadID];
    }
  };

  // Start first send immediately
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
   COMMAND HANDLER
   ══════════════════════════════════════════════════════════ */

function box(title, lines) {
  const bar = '─'.repeat(36);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

/**
 * Handle a STAVEN command.
 * @param {object} event - FCA messageCreate event
 * @param {Function} sendFn - async (msg, threadID) => void
 * @returns {boolean} true if this system handled the command
 */
export function handleStavenCommand(event, sendFn) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');

  // Match: !ستافين تشغيل / !ستافين ايقاف / !ستافين حالة
  if (!body.startsWith('!ستافين')) return false;

  const sub = body.slice('!ستافين'.length).trim();

  // ── DM detection ──
  // Self-messages (bot's own account, senderID === '0') from bot.js are
  // already validated as STAVEN commands — allow them unconditionally.
  const isSelfMsg = senderID === '0';
  if (!isSelfMsg) {
    const isGroup = event?.isGroup === true || event?.threadType === 'group' || (threadID !== senderID && senderID !== '0');
    if (isGroup) return false; // let group handler deal with it
  }

  // ── !ستافين تشغيل ──────────────────────────────────
  if (sub === 'تشغيل' || sub === '') {

    // Already active?
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
    startScheduler(threadID, sendFn);
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

    const wasActive = state[threadID]?.active;
    state[threadID] = { active: false };
    stopScheduler(threadID);
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

    const isActive = state[threadID]?.active;
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

  // Not a STAVEN PRIVATE command
  return false;
}

/* ══════════════════════════════════════════════════════════
   INITIALIZATION
   ══════════════════════════════════════════════════════════ */

/**
 * Initialize the system: load data and restore active schedulers.
 * Call this once when the bot starts.
 * @param {Function} sendFn - async (msg, threadID) => void
 */
export async function initStavenPrivate(sendFn) {
  await loadData();

  // Restore active schedulers
  let restored = 0;
  for (const [tid, s] of Object.entries(state)) {
    if (s.active) {
      startScheduler(tid, sendFn);
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
