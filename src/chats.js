/**
 * !chats — Chat/group management system
 *
 * Usage:
 *   !chats                    — Show main menu
 *   !chats list               — List all groups
 *   !chats requests           — Show pending DM requests
 *   !chats other              — Show "other" conversations
 *   !chats spam               — Show spam conversations
 *   !chats count              — Show chat statistics
 *   !chats dm on              — Enable DM Lock (bot ignores DMs)
 *   !chats dm off             — Disable DM Lock (bot responds to DMs)
 *   !chats accept <thread_id> — Accept DM request and send greeting
 *   !chats <index>            — Manage a specific group by menu index
 *
 * Group management (after selecting a group):
 *   !chats <index> angel on/off  — Toggle angel per group
 *   !chats <index> nm on/off     — Toggle nm per group
 *   !chats <index> nick on/off   — Toggle nick per group
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const CHATS_STATE_FILE = path.resolve('data/chats-state.json');

// Per-chat state: { threadId: { name, messageCount, lastMessageAt, isGroup, settings, category } }
const chatRegistry = new Map();

let dmLock = false;

let activeGroupIndex = null; // Currently selected group for management

/* ── Persistence ───────────────────────────────────────── */

export async function loadChatsState() {
  try {
    const saved = JSON.parse(await fs.readFile(CHATS_STATE_FILE, 'utf8'));
    if (saved.dmLock) dmLock = true;
    if (saved.chats) {
      for (const [id, data] of Object.entries(saved.chats)) {
        chatRegistry.set(id, {
          name: data.name || id,
          messageCount: data.messageCount || 0,
          lastMessageAt: data.lastMessageAt || null,
          isGroup: data.isGroup !== undefined ? data.isGroup : true,
          category: data.category || 'group',
          settings: {
            angelEnabled: data.settings?.angelEnabled || false,
            nmEnabled: data.settings?.nmEnabled || false,
            nickEnabled: data.settings?.nickEnabled || false,
          },
        });
      }
    }
  } catch { /* no saved state */ }
}

async function saveChatsState() {
  try {
    await fs.mkdir(path.dirname(CHATS_STATE_FILE), { recursive: true });
    const chats = {};
    for (const [id, data] of chatRegistry) {
      chats[id] = {
        name: data.name,
        messageCount: data.messageCount,
        lastMessageAt: data.lastMessageAt,
        isGroup: data.isGroup,
        category: data.category,
        settings: { ...data.settings },
      };
    }
    await fs.writeFile(CHATS_STATE_FILE, JSON.stringify({ dmLock, chats }, null, 2));
  } catch {}
}

/* ── Message tracking (called from bot.js) ─────────────── */

/**
 * Track an incoming message for chat management.
 * Called for every message the bot receives.
 */
export function trackMessage(event) {
  const threadID = String(event?.threadID || '');
  if (!threadID) return;

  const isGroup = event?.isGroup !== undefined ? event.isGroup :
                  event?.threadType === 'group' ? true :
                  event?.threadType === 'pm' ? false : true;

  if (!chatRegistry.has(threadID)) {
    chatRegistry.set(threadID, {
      name: event?.threadName || threadID,
      messageCount: 0,
      lastMessageAt: null,
      isGroup,
      category: isGroup ? 'group' : 'other',
      settings: { angelEnabled: false, nmEnabled: false, nickEnabled: false },
    });
  }

  const chat = chatRegistry.get(threadID);
  chat.messageCount++;
  chat.lastMessageAt = Date.now();
  if (event?.senderName) chat.lastSender = event.senderName;

  // Save periodically (every 50 messages)
  if (chat.messageCount % 50 === 0) {
    saveChatsState().catch(() => {});
  }
}

/* ── Chat query helpers ────────────────────────────────── */

export function getChats() {
  return chatRegistry;
}

export function getGroups() {
  const groups = [];
  for (const [id, data] of chatRegistry) {
    if (data.isGroup && data.category === 'group') {
      groups.push({ id, ...data });
    }
  }
  return groups.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

export function getChatCount() {
  let groups = 0, requests = 0, other = 0, spam = 0;
  for (const data of chatRegistry.values()) {
    switch (data.category) {
      case 'group': groups++; break;
      case 'request': requests++; break;
      case 'spam': spam++; break;
      default: other++; break;
    }
  }
  return { groups, requests, other, spam };
}

export function isDmLocked() { return dmLock; }

/**
 * Check if a thread allows bot replies (not DM locked).
 */
export function canReply(threadID, isGroup) {
  if (!isGroup && dmLock) return false;
  return true;
}

export function getGroupSettings(threadID) {
  const chat = chatRegistry.get(threadID);
  if (!chat) return null;
  return { ...chat.settings };
}

export function updateGroupSettings(threadID, key, value) {
  const chat = chatRegistry.get(threadID);
  if (!chat) return false;
  chat.settings[key] = value;
  saveChatsState().catch(() => {});
  return true;
}

export function setChatCategory(threadID, category) {
  const chat = chatRegistry.get(threadID);
  if (chat) {
    chat.category = category;
    saveChatsState().catch(() => {});
  }
}

/**
 * Register a DM request (incoming DM for the first time).
 */
export function registerDmRequest(threadID, senderName) {
  const chat = chatRegistry.get(threadID);
  if (!chat) {
    chatRegistry.set(threadID, {
      name: senderName || threadID,
      messageCount: 0,
      lastMessageAt: Date.now(),
      isGroup: false,
      category: 'request',
      settings: { angelEnabled: false, nmEnabled: false, nickEnabled: false },
    });
  } else if (chat.category === 'other' || chat.category === 'request') {
    // First message from an "other" chat — could be a request
    if (chat.messageCount <= 2 && chat.category !== 'request') {
      chat.category = 'request';
    }
  }
  saveChatsState().catch(() => {});
}

/**
 * Accept a DM request — change category to "other" and send greeting.
 */
export function acceptDmRequest(threadID) {
  const chat = chatRegistry.get(threadID);
  if (!chat || chat.category !== 'request') return false;
  chat.category = 'other';
  saveChatsState().catch(() => {});
  return true;
}

/**
 * Mark a chat as spam.
 */
export function markAsSpam(threadID) {
  const chat = chatRegistry.get(threadID);
  if (!chat) return false;
  chat.category = 'spam';
  saveChatsState().catch(() => {});
  return true;
}

/* ── Handle !chats command ─────────────────────────────── */

/**
 * @param {object} message - FCA messageCreate event
 * @param {object} api - FCA bot API
 * @returns {object} reply object
 */
export async function handleChats(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1); // remove "!chats"
  const sub = (parts[0] || '').toLowerCase();

  // !chats (no args) — show menu
  if (!sub) {
    return showMenu();
  }

  // !chats list
  if (sub === 'list') {
    return showGroupList();
  }

  // !chats requests
  if (sub === 'requests') {
    return showRequests();
  }

  // !chats other
  if (sub === 'other') {
    return showOther();
  }

  // !chats spam
  if (sub === 'spam') {
    return showSpam();
  }

  // !chats count
  if (sub === 'count') {
    return showStats();
  }

  // !chats dm on/off
  if (sub === 'dm') {
    return handleDmLock(parts[1]);
  }

  // !chats accept <thread_id>
  if (sub === 'accept') {
    return handleAccept(parts[1], api);
  }

  // !chats <index> — manage specific group
  const index = parseInt(sub, 10);
  if (!isNaN(index) && index >= 1) {
    return handleGroupManagement(index - 1, parts.slice(1), api);
  }

  return showMenu();
}

/* ── Menu displays ─────────────────────────────────────── */

function showMenu() {
  const counts = getChatCount();
  return {
    type: 'reply',
    text: [
      '💬 Chats Management',
      '',
      '1️⃣ Groups — ' + counts.groups,
      '2️⃣ Requests — ' + counts.requests,
      '3️⃣ Other / Spam — ' + (counts.other + counts.spam),
      '4️⃣ Statistics',
      '5️⃣ DM Lock — ' + (dmLock ? '🔒 ON' : '🔓 OFF'),
      '',
      'Commands:',
      '!chats list — Groups',
      '!chats requests — DM requests',
      '!chats other — Other conversations',
      '!chats spam — Spam',
      '!chats count — Statistics',
      '!chats dm on/off — Toggle DM Lock',
      '!chats accept <id> — Accept DM',
      '!chats <index> — Manage group',
    ].join('\n'),
  };
}

function showGroupList() {
  const groups = getGroups();
  if (groups.length === 0) {
    return { type: 'reply', text: '💬 No groups tracked yet.' };
  }

  const lines = groups.slice(0, 20).map((g, i) => {
    const angel = g.settings.angelEnabled ? ' 👻' : '';
    const nm = g.settings.nmEnabled ? ' 🔇' : '';
    const nick = g.settings.nickEnabled ? ' ✏️' : '';
    const flags = angel + nm + nick || ' —';
    return `${i + 1}. ${g.name}${flags}`;
  });

  return {
    type: 'reply',
    text: [
      `💬 Groups (${groups.length}):`,
      '',
      ...lines,
      groups.length > 20 ? `\n... and ${groups.length - 20} more` : '',
      '',
      'Reply with a number to manage a group.',
    ].join('\n'),
  };
}

function showRequests() {
  const requests = [];
  for (const [id, data] of chatRegistry) {
    if (data.category === 'request') {
      requests.push({ id, ...data });
    }
  }

  if (requests.length === 0) {
    return { type: 'reply', text: '💬 No pending DM requests.' };
  }

  const lines = requests.map((r) => {
    return `• ${r.name} (${r.id}) — ${fmtTime(r.lastMessageAt)}`;
  });

  return {
    type: 'reply',
    text: [
      `💬 DM Requests (${requests.length}):`,
      '',
      ...lines,
      '',
      'Accept: !chats accept <thread_id>',
    ].join('\n'),
  };
}

function showOther() {
  const others = [];
  for (const [id, data] of chatRegistry) {
    if (data.category === 'other') {
      others.push({ id, ...data });
    }
  }

  if (others.length === 0) {
    return { type: 'reply', text: '💬 No "other" conversations.' };
  }

  const lines = others.map((c) => {
    return `• ${c.name} (${c.id}) — ${c.messageCount} msgs`;
  });

  return {
    type: 'reply',
    text: [`💬 Other Conversations (${others.length}):`, '', ...lines].join('\n'),
  };
}

function showSpam() {
  const spam = [];
  for (const [id, data] of chatRegistry) {
    if (data.category === 'spam') {
      spam.push({ id, ...data });
    }
  }

  if (spam.length === 0) {
    return { type: 'reply', text: '💬 No spam conversations.' };
  }

  const lines = spam.map((s) => {
    return `• ${s.name} (${s.id}) — ${s.messageCount} msgs`;
  });

  return {
    type: 'reply',
    text: [`💬 Spam (${spam.length}):`, '', ...lines].join('\n'),
  };
}

function showStats() {
  const counts = getChatCount();
  const total = counts.groups + counts.requests + counts.other + counts.spam;
  let totalMsgs = 0;
  for (const data of chatRegistry.values()) {
    totalMsgs += data.messageCount || 0;
  }

  return {
    type: 'reply',
    text: [
      '📊 Chat Statistics',
      '',
      `Total Tracked: ${total}`,
      `Groups: ${counts.groups}`,
      `DM Requests: ${counts.requests}`,
      `Other: ${counts.other}`,
      `Spam: ${counts.spam}`,
      `Total Messages: ${totalMsgs}`,
      `DM Lock: ${dmLock ? '🔒 ON' : '🔓 OFF'}`,
    ].join('\n'),
  };
}

function handleDmLock(action) {
  if (!action) {
    return {
      type: 'reply',
      text: `DM Lock is currently: ${dmLock ? '🔒 ON' : '🔓 OFF'}\nUsage: !chats dm on/off`,
    };
  }

  const val = action.toLowerCase();
  if (val === 'on' || val === 'enable') {
    dmLock = true;
    saveChatsState().catch(() => {});
    return { type: 'reply', text: '🔒 DM Lock enabled. Bot will not respond to DMs.' };
  }
  if (val === 'off' || val === 'disable') {
    dmLock = false;
    saveChatsState().catch(() => {});
    return { type: 'reply', text: '🔓 DM Lock disabled. Bot will respond to DMs.' };
  }

  return { type: 'reply', text: '❌ Usage: !chats dm on/off' };
}

async function handleAccept(threadID, api) {
  if (!threadID) {
    return { type: 'reply', text: '❌ Provide a thread ID:\n!chats accept <thread_id>' };
  }

  const accepted = acceptDmRequest(threadID);
  if (!accepted) {
    return { type: 'reply', text: `❌ Thread ${threadID} is not a pending request.` };
  }

  // Send greeting
  try {
    await api.sendMessage('اهلاً وسهلاً! 👋', threadID);
  } catch (err) {
    return {
      type: 'reply',
      text: `⚠️ Request accepted but failed to send greeting: ${err?.message}`,
    };
  }

  return {
    type: 'reply',
    text: `✅ DM request from ${threadID} accepted and greeting sent.`,
  };
}

function handleGroupManagement(index, subParts, api) {
  const groups = getGroups();

  if (index < 0 || index >= groups.length) {
    return { type: 'reply', text: `❌ Invalid group number. Use !chats list to see available groups.` };
  }

  const group = groups[index];
  const sub = (subParts[0] || '').toLowerCase();

  // No sub-command: show group info and management menu
  if (!sub) {
    activeGroupIndex = index;
    return {
      type: 'reply',
      text: [
        `💬 Group: ${group.name}`,
        `ID: ${group.id}`,
        `Messages: ${group.messageCount}`,
        `Last: ${fmtTime(group.lastMessageAt)}`,
        '',
        'Settings:',
        `  Angel: ${group.settings.angelEnabled ? '✅ ON' : '❌ OFF'}`,
        `  NM: ${group.settings.nmEnabled ? '✅ ON' : '❌ OFF'}`,
        `  Nick: ${group.settings.nickEnabled ? '✅ ON' : '❌ OFF'}`,
        '',
        'Commands:',
        `!chats ${index + 1} angel on/off`,
        `!chats ${index + 1} nm on/off`,
        `!chats ${index + 1} nick on/off`,
      ].join('\n'),
    };
  }

  // !chats <index> angel on/off
  if (sub === 'angel') {
    const val = (subParts[1] || '').toLowerCase();
    if (val === 'on') {
      updateGroupSettings(group.id, 'angelEnabled', true);
      return { type: 'reply', text: `👻 Angel enabled for ${group.name}.` };
    }
    if (val === 'off') {
      updateGroupSettings(group.id, 'angelEnabled', false);
      return { type: 'reply', text: `👻 Angel disabled for ${group.name}.` };
    }
    return {
      type: 'reply',
      text: `Angel status: ${group.settings.angelEnabled ? 'ON' : 'OFF'}\nUsage: !chats ${index + 1} angel on/off`,
    };
  }

  // !chats <index> nm on/off
  if (sub === 'nm') {
    const val = (subParts[1] || '').toLowerCase();
    if (val === 'on') {
      updateGroupSettings(group.id, 'nmEnabled', true);
      return { type: 'reply', text: `🔇 NM enabled for ${group.name}.` };
    }
    if (val === 'off') {
      updateGroupSettings(group.id, 'nmEnabled', false);
      return { type: 'reply', text: `🔇 NM disabled for ${group.name}.` };
    }
    return {
      type: 'reply',
      text: `NM status: ${group.settings.nmEnabled ? 'ON' : 'OFF'}\nUsage: !chats ${index + 1} nm on/off`,
    };
  }

  // !chats <index> nick on/off
  if (sub === 'nick') {
    const val = (subParts[1] || '').toLowerCase();
    if (val === 'on') {
      updateGroupSettings(group.id, 'nickEnabled', true);
      return { type: 'reply', text: `✏️ Nick enabled for ${group.name}.` };
    }
    if (val === 'off') {
      updateGroupSettings(group.id, 'nickEnabled', false);
      return { type: 'reply', text: `✏️ Nick disabled for ${group.name}.` };
    }
    return {
      type: 'reply',
      text: `Nick status: ${group.settings.nickEnabled ? 'ON' : 'OFF'}\nUsage: !chats ${index + 1} nick on/off`,
    };
  }

  return {
    type: 'reply',
    text: [
      `❌ Unknown sub-command: "${sub}"`,
      `Available: angel, nm, nick`,
      `Example: !chats ${index + 1} angel on`,
    ].join('\n'),
  };
}

function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return '—'; }
}
