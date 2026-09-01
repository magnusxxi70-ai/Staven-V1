/**
 * !angel — Auto messaging system
 *
 * Usage:
 *   !angel <message> <min> <max>  — Start auto messaging
 *   !angel off                     — Stop
 *   !angel status                  — Show status
 *   !angel                         — Show status
 *
 * Features:
 *   - Random interval between min and max seconds
 *   - Typing simulation before send
 *   - Pauses after 3 consecutive no-reply messages
 *   - Resumes on human reply
 *   - Escape + leave after 16 min silence
 *   - State persists across restarts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ANGEL_STATE_FILE = path.resolve('data/angel-state.json');

const DEFAULT_MIN = 60;
const DEFAULT_MAX = 120;
const SILENCE_TIMEOUT = 16 * 60 * 1000;
const CONSECUTIVE_LIMIT = 3;
const TYPING_DELAY = 2000;
const ESCAPE_MESSAGE = 'الم Elo ... مع السلامة';

const angelStates = {};

/* ── Box helper ───────────────────────────────────────── */

function box(title, lines) {
  const w = 36;
  const border = '─'.repeat(w);
  return [
    `╭${border}╮`,
    `│ ${title}`,
    `╰${border}╯`,
    ...lines,
    '─'.repeat(w + 2),
  ].join('\n');
}

/* ── Public API ───────────────────────────────────────── */

export function getAngelState(chatId) {
  const s = angelStates[chatId];
  if (!s) return null;
  const { timer, silenceTimer, ...rest } = s;
  return rest;
}

export function isAngelActive(chatId) {
  return angelStates[chatId]?.active === true;
}

/* ── Command Handler ──────────────────────────────────── */

export async function handleAngel(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1);
  const threadID = String(message?.threadID || '');

  if (parts.length === 0 || parts[0].toLowerCase() === 'status') {
    return handleStatus(threadID);
  }

  if (parts[0].toLowerCase() === 'off') {
    return handleOff(threadID);
  }

  // !angel help
  if (parts[0].toLowerCase() === 'help') {
    return {
      type: 'reply',
      text: box('👻 !angel — Guide', [
        '',
        '╭─── التشغيل ─────────────────────╮',
        '│ !angel <رسالة> <min> <max>       │',
        '│ مثال: !angel هلا 60 80           │',
        '│ مثال: !angel أهلاً 90 120        │',
        '╰──────────────────────────────────╯',
        '',
        '╭─── التحكم ──────────────────────╮',
        '│ !angel        ← عرض الحالة       │',
        '│ !angel status ← عرض الحالة       │',
        '│ !angel off    ← إيقاف الملاك     │',
        '│ !angel help   ← هذا الدليل       │',
        '╰──────────────────────────────────╯',
        '',
        'السلوكيات:',
        '• إرسال عشوائي بين min و max ثانية',
        '• محاكاة الكتابة قبل الإرسال',
        '• توقف مؤقت بعد 3 رسائل بدون رد',
        '• استئناف عند وصول رد بشري',
        '• مغادرة بعد 16 دقيقة صمت',
      ]),
    };
  }

  return handleStart(parts, threadID, message?.senderID, api);
}

function handleStatus(threadID) {
  const state = angelStates[threadID];

  if (!state || !state.active) {
    return {
      type: 'reply',
      text: box('👻 Angel Status', [
        '',
        'الحالة: ❌ غير نشط',
        'لا يوجد ملاك نشط في هذا المحادثة.',
      ]),
    };
  }

  return {
    type: 'reply',
    text: box('👻 Angel Status', [
      '',
      `✅ الحالة: نشط`,
      `💬 الرسالة: ${state.message}`,
      `⏱️ الفاصل: ${state.min}s – ${state.max}s`,
      `📨 تم الإرسال: ${state.totalSent}`,
      `🔕 بدون رد: ${state.consecutiveNoReply}/${CONSECUTIVE_LIMIT}`,
      `🕐 بدء: ${fmtTime(state.lastSentAt || state.startedAt)}`,
      `🔄 آخر إرسال: ${fmtTime(state.lastSentAt)}`,
    ]),
  };
}

function handleOff(threadID) {
  const state = angelStates[threadID];
  if (!state) {
    return {
      type: 'reply',
      text: box('👻 Angel', ['', 'الملاك غير نشط في هذا المحادثة.']),
    };
  }

  state.active = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  saveAngelState();

  return {
    type: 'reply',
    text: box('👻 Angel Stopped', [
      '',
      'تم إيقاف الملاك بنجاح.',
      `رسائل مرسلة: ${state.totalSent}`,
    ]),
  };
}

async function handleStart(parts, threadID, senderID, api) {
  if (angelStates[threadID]?.active) {
    return {
      type: 'reply',
      text: box('👻 Angel', [
        '',
        'الملاك نشط بالفعل في هذا المحادثة.',
        'استخدم !angel off لإيقافه أولاً.',
      ]),
    };
  }

  let min, max, messageText;

  if (parts.length >= 3) {
    const last = parseInt(parts[parts.length - 1], 10);
    const secondLast = parseInt(parts[parts.length - 2], 10);
    if (!isNaN(last) && !isNaN(secondLast)) {
      min = Math.max(10, secondLast);
      max = Math.max(min, last);
      messageText = parts.slice(0, -2).join(' ');
    } else {
      messageText = parts.join(' ');
      min = DEFAULT_MIN;
      max = DEFAULT_MAX;
    }
  } else if (parts.length === 2) {
    const last = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(last)) {
      min = Math.max(10, last);
      max = min;
      messageText = parts.slice(0, -1).join(' ');
    } else {
      messageText = parts.join(' ');
      min = DEFAULT_MIN;
      max = DEFAULT_MAX;
    }
  } else {
    messageText = parts.join(' ');
    min = DEFAULT_MIN;
    max = DEFAULT_MAX;
  }

  if (!messageText) {
    return {
      type: 'reply',
      text: box('❌ خطأ', ['', 'الرسالة لا يمكن أن تكون فارغة.']),
    };
  }

  const now = Date.now();
  angelStates[threadID] = {
    chatId: threadID,
    message: messageText,
    senderID,
    min,
    max,
    active: true,
    consecutiveNoReply: 0,
    totalSent: 0,
    startedAt: now,
    lastSentAt: null,
    lastHumanReplyAt: now,
    pausedReason: null,
    timer: null,
  };

  saveAngelState();
  scheduleNextSend(threadID, api);

  return {
    type: 'reply',
    text: box('👻 Angel Started ✅', [
      '',
      `💬 الرسالة: ${messageText}`,
      `⏱️ الفاصل: ${min}s – ${max}s`,
      `🛑 التوقف بعد: ${CONSECUTIVE_LIMIT} رسائل بدون رد`,
      `⏰ مهلة الصمت: 16 دقيقة`,
    ]),
  };
}

/* ── Timer Logic ──────────────────────────────────────── */

function scheduleNextSend(chatId, api) {
  const state = angelStates[chatId];
  if (!state || !state.active) return;

  const delay = randomBetween(state.min, state.max) * 1000;
  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(async () => {
    if (!state.active) return;
    const result = await sendAngelMessage(chatId, api);
    if (result === 'stopped') return;
    scheduleNextSend(chatId, api);
  }, delay);

  if (state.timer?.unref) state.timer.unref();
}

async function sendAngelMessage(chatId, api) {
  const state = angelStates[chatId];
  if (!state || !state.active) return 'stopped';

  // Check silence timeout
  if (state.lastHumanReplyAt) {
    if (Date.now() - state.lastHumanReplyAt >= SILENCE_TIMEOUT) {
      try {
        if (api?.sendTyping) { try { api.sendTyping(chatId); } catch {} await sleep(TYPING_DELAY); }
        await api.sendMessage(ESCAPE_MESSAGE, chatId);
      } catch {}
      state.active = false;
      state.pausedReason = 'silence_timeout';
      try {
        if (api?.leaveThread) api.leaveThread(chatId);
        else if (api?.leaveGroup) api.leaveGroup(chatId);
      } catch {}
      saveAngelState();
      return 'stopped';
    }
  }

  try {
    if (api?.sendTyping) { try { api.sendTyping(chatId); } catch {} await sleep(TYPING_DELAY); }
    await api.sendMessage(state.message, chatId);

    state.totalSent++;
    state.lastSentAt = Date.now();
    state.consecutiveNoReply++;

    if (state.consecutiveNoReply >= CONSECUTIVE_LIMIT) {
      state.active = false;
      state.pausedReason = 'consecutive_no_reply';
      saveAngelState();
      return 'stopped';
    }

    saveAngelState();
    return 'sent';
  } catch {
    state.active = false;
    state.pausedReason = 'error';
    saveAngelState();
    return 'error';
  }
}

/* ── Human Reply Handler ──────────────────────────────── */

export function onHumanMessage(chatId, api) {
  const state = angelStates[chatId];
  if (!state) return;

  state.lastHumanReplyAt = Date.now();

  if (!state.active && state.pausedReason === 'consecutive_no_reply') {
    state.active = true;
    state.consecutiveNoReply = 0;
    state.pausedReason = null;
    scheduleNextSend(chatId, api);
    saveAngelState();
  }
}

export async function angelLeaveGroup(chatId, api) {
  const state = angelStates[chatId];
  if (state) { state.active = false; if (state.timer) clearTimeout(state.timer); }
  try { if (api?.leaveThread) api.leaveThread(chatId); else if (api?.leaveGroup) api.leaveGroup(chatId); } catch {}
  saveAngelState();
}

/* ── Persistence ──────────────────────────────────────── */

async function saveAngelState() {
  try {
    await fs.mkdir(path.dirname(ANGEL_STATE_FILE), { recursive: true });
    const saveData = {};
    for (const [chatId, state] of Object.entries(angelStates)) {
      const { timer, silenceTimer, ...rest } = state;
      saveData[chatId] = rest;
    }
    await fs.writeFile(ANGEL_STATE_FILE, JSON.stringify(saveData, null, 2));
  } catch {}
}

export async function loadAngelState(api) {
  try {
    const saved = JSON.parse(await fs.readFile(ANGEL_STATE_FILE, 'utf8'));
    for (const [chatId, data] of Object.entries(saved)) {
      if (data.active) {
        angelStates[chatId] = { ...data, timer: null };
        if (api) scheduleNextSend(chatId, api);
      }
    }
  } catch {}
}

export function cleanupAngels() {
  for (const state of Object.values(angelStates)) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  }
}

/* ── Utilities ────────────────────────────────────────── */

function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtTime(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString(); } catch { return '—'; } }
