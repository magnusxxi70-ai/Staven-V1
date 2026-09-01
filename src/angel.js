/**
 * !angel — Auto messaging system
 *
 * Usage:
 *   !angel <message> <min_seconds> <max_seconds>  — Start auto messaging
 *   !angel off                                     — Stop auto messaging
 *   !angel status                                  — Show current status
 *   !angel                                         — Show status (alias)
 *
 * Behavior:
 *   - Sends the message at random intervals between min and max seconds
 *   - Simulates typing before each send
 *   - After 3 consecutive messages without human reply, pauses automatically
 *   - When a human reply is received, resumes and resets the counter
 *   - After 16 minutes of no human reply, sends escape message and leaves the group
 *   - State persists across bot restarts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ANGEL_STATE_FILE = path.resolve('data/angel-state.json');

const DEFAULT_MIN = 60;   // 1 minute
const DEFAULT_MAX = 120;  // 2 minutes
const SILENCE_TIMEOUT = 16 * 60 * 1000; // 16 minutes in ms
const CONSECUTIVE_LIMIT = 3;
const TYPING_DELAY = 2000; // 2 seconds typing simulation
const ESCAPE_MESSAGE = 'الم Elo ... مع السلامة';
const MAX_MESSAGE_LENGTH = 2000;

// { threadId: { chatId, message, senderID, min, max, ... } }
const angelStates = {};

let silenceTimer = null;

export function getAngelState(chatId) {
  const s = angelStates[chatId];
  if (!s) return null;
  return {
    chatId: s.chatId,
    message: s.message,
    senderID: s.senderID,
    min: s.min,
    max: s.max,
    active: s.active,
    consecutiveNoReply: s.consecutiveNoReply,
    totalSent: s.totalSent,
    startedAt: s.startedAt,
    lastSentAt: s.lastSentAt,
    lastHumanReplyAt: s.lastHumanReplyAt,
    pausedReason: s.pausedReason || null,
  };
}

export function isAngelActive(chatId) {
  return angelStates[chatId]?.active === true;
}

/**
 * Handle the !angel command.
 * @param {object} message - FCA messageCreate event
 * @param {object} api - FCA bot API
 * @returns {object} reply object
 */
export async function handleAngel(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1); // remove "!angel"
  const threadID = String(message?.threadID || '');
  const senderID = String(message?.senderID || '');

  // !angel or !angel status
  if (parts.length === 0 || parts[0].toLowerCase() === 'status') {
    return handleStatus(threadID);
  }

  // !angel off
  if (parts[0].toLowerCase() === 'off') {
    return handleOff(threadID);
  }

  // !angel <message> [min] [max]
  return handleStart(parts, threadID, senderID, api);
}

async function handleStatus(threadID) {
  const state = angelStates[threadID];

  if (!state || !state.active) {
    return {
      type: 'reply',
      text: '👻 Angel: Not active in this chat.',
    };
  }

  return {
    type: 'reply',
    text: [
      '👻 Angel Status',
      `Message: ${state.message}`,
      `Interval: ${state.min}s – ${state.max}s`,
      `Sent: ${state.totalSent}`,
      `No-reply count: ${state.consecutiveNoReply}/${CONSECUTIVE_LIMIT}`,
      `Started: ${fmtTime(state.startedAt)}`,
      `Last sent: ${fmtTime(state.lastSentAt)}`,
    ].join('\n'),
  };
}

async function handleOff(threadID) {
  const state = angelStates[threadID];
  if (!state) {
    return { type: 'reply', text: '👻 Angel is not active in this chat.' };
  }

  state.active = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;

  await saveAngelState();
  return { type: 'reply', text: '👻 Angel stopped.' };
}

async function handleStart(parts, threadID, senderID, api) {
  // Check if already active
  if (angelStates[threadID]?.active) {
    return {
      type: 'reply',
      text: '👻 Angel is already active in this chat.\nUse !angel off to stop it first.',
    };
  }

  if (parts.length < 1) {
    return {
      type: 'reply',
      text: [
        '👻 Usage:',
        '!angel <message> [min_seconds] [max_seconds]',
        '',
        'Examples:',
        '!angel هلا 60 80',
        '!angel أهلاً وسهلاً 90 120',
      ].join('\n'),
    };
  }

  // Parse arguments
  let min, max, messageText;

  // Check if last two args are numbers (min and max)
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
      // Could be message + one number, treat as min=max
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
    return { type: 'reply', text: '❌ Message cannot be empty.' };
  }

  const now = Date.now();
  const state = {
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
    silenceTimer: null,
  };

  angelStates[threadID] = state;

  await saveAngelState();
  scheduleNextSend(threadID, api);

  return {
    type: 'reply',
    text: [
      '👻 Angel started!',
      `Message: ${messageText}`,
      `Interval: ${min}s – ${max}s`,
    ].join('\n'),
  };
}

function scheduleNextSend(chatId, api) {
  const state = angelStates[chatId];
  if (!state || !state.active) return;

  const delay = randomBetween(state.min, state.max) * 1000;

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    if (!state.active) return;

    const result = await sendAngelMessage(chatId, api);
    if (result === 'stopped') return; // hit silence limit

    scheduleNextSend(chatId, api);
  }, delay);

  // Prevent timer from keeping process alive
  if (state.timer.unref) state.timer.unref();
}

async function sendAngelMessage(chatId, api) {
  const state = angelStates[chatId];
  if (!state || !state.active) return 'stopped';

  // Check silence timeout (16 minutes)
  if (state.lastHumanReplyAt) {
    const timeSinceReply = Date.now() - state.lastHumanReplyAt;
    if (timeSinceReply >= SILENCE_TIMEOUT) {
      // Send escape message then leave
      try {
        // Simulate typing
        if (api?.sendTyping) {
          try { api.sendTyping(chatId); } catch {}
          await sleep(TYPING_DELAY);
        }
        await api.sendMessage(ESCAPE_MESSAGE, chatId);
      } catch {}
      state.active = false;
      state.pausedReason = 'silence_timeout';
      console.log(`[ANGEL] Chat ${chatId}: silence timeout — sending escape and leaving`);
      try {
        if (api?.leaveThread) api.leaveThread(chatId);
        else if (api?.leaveGroup) api.leaveGroup(chatId);
      } catch {}
      await saveAngelState();
      return 'stopped';
    }
  }

  try {
    // Simulate typing
    if (api?.sendTyping) {
      try { api.sendTyping(chatId); } catch {}
      await sleep(TYPING_DELAY);
    }

    await api.sendMessage(state.message, chatId);

    state.totalSent++;
    state.lastSentAt = Date.now();
    state.consecutiveNoReply++;

    console.log(`[ANGEL] Chat ${chatId}: sent #${state.totalSent} (no-reply: ${state.consecutiveNoReply})`);

    // Check consecutive no-reply limit
    if (state.consecutiveNoReply >= CONSECUTIVE_LIMIT) {
      state.active = false;
      state.pausedReason = 'consecutive_no_reply';
      console.log(`[ANGEL] Chat ${chatId}: paused after ${CONSECUTIVE_LIMIT} consecutive messages without reply`);
      await saveAngelState();
      return 'stopped';
    }

    await saveAngelState();
    return 'sent';
  } catch (err) {
    console.error(`[ANGEL] Chat ${chatId}: send failed:`, err?.message);
    state.active = false;
    state.pausedReason = 'error';
    await saveAngelState();
    return 'error';
  }
}

/**
 * Called by the bot when a human message arrives in a thread with active angel.
 * Resumes angel if it was paused due to no reply.
 */
export function onHumanMessage(chatId, api) {
  const state = angelStates[chatId];
  if (!state) return;

  state.lastHumanReplyAt = Date.now();

  if (!state.active && state.pausedReason === 'consecutive_no_reply') {
    // Resume angel
    state.active = true;
    state.consecutiveNoReply = 0;
    state.pausedReason = null;
    console.log(`[ANGEL] Chat ${chatId}: resumed after human reply`);
    scheduleNextSend(chatId, api);
    saveAngelState().catch(() => {});
  }
}

/**
 * Leave group for angel escape (called from chats module).
 */
export async function angelLeaveGroup(chatId, api) {
  const state = angelStates[chatId];
  if (state) {
    state.active = false;
    if (state.timer) clearTimeout(state.timer);
  }
  try {
    if (api?.leaveThread) api.leaveThread(chatId);
    else if (api?.leaveGroup) api.leaveGroup(chatId);
  } catch {}
  await saveAngelState();
}

/* ── Persistence ───────────────────────────────────────── */

async function saveAngelState() {
  try {
    await fs.mkdir(path.dirname(ANGEL_STATE_FILE), { recursive: true });
    // Save only serializable data (not timers)
    const saveData = {};
    for (const [chatId, state] of Object.entries(angelStates)) {
      saveData[chatId] = {
        chatId: state.chatId,
        message: state.message,
        senderID: state.senderID,
        min: state.min,
        max: state.max,
        active: state.active,
        consecutiveNoReply: state.consecutiveNoReply,
        totalSent: state.totalSent,
        startedAt: state.startedAt,
        lastSentAt: state.lastSentAt,
        lastHumanReplyAt: state.lastHumanReplyAt,
        pausedReason: state.pausedReason,
      };
    }
    await fs.writeFile(ANGEL_STATE_FILE, JSON.stringify(saveData, null, 2));
  } catch {}
}

export async function loadAngelState(api) {
  try {
    const saved = JSON.parse(await fs.readFile(ANGEL_STATE_FILE, 'utf8'));
    for (const [chatId, data] of Object.entries(saved)) {
      if (data.active) {
        const state = { ...data, timer: null, silenceTimer: null };
        angelStates[chatId] = state;
        if (api) scheduleNextSend(chatId, api);
        console.log(`[ANGEL] Restored active angel for chat ${chatId}`);
      }
    }
  } catch { /* no saved state */ }
}

export function cleanupAngels() {
  for (const state of Object.values(angelStates)) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
  }
}

/* ── Utilities ─────────────────────────────────────────── */

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return '—'; }
}
