/**
 * !chats — Chat/group management system
 *
 * Usage:
 *   !chats                    — Show main menu
 *   !chats list               — List all groups
 *   !chats requests           — Show pending DM requests
 *   !chats other              — Show "other" conversations
 *   !chats spam               — Show spam
 *   !chats count              — Statistics
 *   !chats dm on/off          — Toggle DM Lock
 *   !chats accept <thread_id> — Accept DM request
 *   !chats <index>            — Manage group by index
 *   !chats <index> angel/nm/nick on/off
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const CHATS_STATE_FILE = path.resolve('data/chats-state.json');

const chatRegistry = new Map();
let dmLock = false;

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

function fmtTime(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleString(); } catch { return '—'; } }

/* ── Persistence ──────────────────────────────────────── */

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
  } catch {}
}

async function saveChatsState() {
  try {
    await fs.mkdir(path.dirname(CHATS_STATE_FILE), { recursive: true });
    const chats = {};
    for (const [id, data] of chatRegistry) {
      chats[id] = { ...data, settings: { ...data.settings } };
    }
    await fs.writeFile(CHATS_STATE_FILE, JSON.stringify({ dmLock, chats }, null, 2));
  } catch {}
}

/* ── Public API ───────────────────────────────────────── */

export function trackMessage(event) {
  const threadID = String(event?.threadID || '');
  if (!threadID) return;
  const isGroup = event?.isGroup !== undefined ? event.isGroup : event?.threadType !== 'pm';

  if (!chatRegistry.has(threadID)) {
    chatRegistry.set(threadID, {
      name: event?.threadName || threadID,
      messageCount: 0, lastMessageAt: null, isGroup,
      category: isGroup ? 'group' : 'other',
      settings: { angelEnabled: false, nmEnabled: false, nickEnabled: false },
    });
  }
  const chat = chatRegistry.get(threadID);
  chat.messageCount++;
  chat.lastMessageAt = Date.now();
  if (chat.messageCount % 50 === 0) saveChatsState().catch(() => {});
}

export function getChats() { return chatRegistry; }
export function isDmLocked() { return dmLock; }
export function canReply(threadID, isGroup) { return isGroup || !dmLock; }

export function getGroupSettings(threadID) {
  const c = chatRegistry.get(threadID);
  return c ? { ...c.settings } : null;
}

export function updateGroupSettings(threadID, key, value) {
  const c = chatRegistry.get(threadID);
  if (!c) return false;
  c.settings[key] = value;
  saveChatsState().catch(() => {});
  return true;
}

export function acceptDmRequest(threadID) {
  const c = chatRegistry.get(threadID);
  if (!c || c.category !== 'request') return false;
  c.category = 'other';
  saveChatsState().catch(() => {});
  return true;
}

export function getGroups() {
  const groups = [];
  for (const [id, data] of chatRegistry) {
    if (data.isGroup && data.category === 'group') groups.push({ id, ...data });
  }
  return groups.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
}

function getChatCount() {
  let groups = 0, requests = 0, other = 0, spam = 0;
  for (const d of chatRegistry.values()) {
    if (d.category === 'group') groups++;
    else if (d.category === 'request') requests++;
    else if (d.category === 'spam') spam++;
    else other++;
  }
  return { groups, requests, other, spam };
}

function getByCategory(cat) {
  const list = [];
  for (const [id, data] of chatRegistry) {
    if (data.category === cat) list.push({ id, ...data });
  }
  return list;
}

/* ── Command Handler ──────────────────────────────────── */

export async function handleChats(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1);
  const sub = (parts[0] || '').toLowerCase();

  if (!sub) return showMenu();
  if (sub === 'list') return showGroupList();
  if (sub === 'requests') return showRequests();
  if (sub === 'other') return showOther();
  if (sub === 'spam') return showSpam();
  if (sub === 'count') return showStats();
  if (sub === 'dm') return handleDmLock(parts[1]);
  if (sub === 'accept') return handleAccept(parts[1], api);

  const index = parseInt(sub, 10);
  if (!isNaN(index) && index >= 1) {
    return handleGroupManagement(index - 1, parts.slice(1), api);
  }

  return showMenu();
}

/* ── Main Menu ────────────────────────────────────────── */

function showMenu() {
  const c = getChatCount();
  return {
    type: 'reply',
    text: box('💬 Chats Management', [
      '',
      `╭─── القائمة الرئيسية ──────────╮`,
      `│ 1️⃣  الغروبات       │ ${c.groups}`,
      `│ 2️⃣  طلبات المراسلة  │ ${c.requests}`,
      `│ 3️⃣  أخرى / Spam    │ ${c.other + c.spam}`,
      `│ 4️⃣  الإحصائيات`,
      `│ 5️⃣  DM Lock        │ ${dmLock ? '🔒 ON' : '🔓 OFF'}`,
      `╰────────────────────────────────╯`,
      '',
      'الأوامر:',
      '!chats list         → عرض الغروبات',
      '!chats requests     → طلبات المراسلة',
      '!chats other        → أخرى',
      '!chats spam         → Spam',
      '!chats count        → الإحصائيات',
      '!chats dm on/off    → قفل الرسائل',
      '!chats accept <id>  → قبول طلب',
      '!chats <رقم>        → إدارة غروب',
    ]),
  };
}

/* ── Sub-menus ────────────────────────────────────────── */

function showGroupList() {
  const groups = getGroups();
  if (groups.length === 0) {
    return { type: 'reply', text: box('💬 الغروبات', ['', 'لا توجد غروبات مسجلة بعد.']) };
  }

  const lines = ['', ...groups.slice(0, 15).map((g, i) => {
    const flags = [];
    if (g.settings.angelEnabled) flags.push('👻');
    if (g.settings.nmEnabled) flags.push('🔇');
    if (g.settings.nickEnabled) flags.push('✏️');
    return `${i + 1}. ${g.name} ${flags.length ? flags.join('') : ''}`;
  })];

  if (groups.length > 15) lines.push(`\n... و ${groups.length - 15} أخرى`);
  lines.push('', 'أرسل رقم لإدارة غروب.');

  return { type: 'reply', text: box(`💬 الغروبات (${groups.length})`, lines) };
}

function showRequests() {
  const requests = getByCategory('request');
  if (requests.length === 0) {
    return { type: 'reply', text: box('💬 طلبات المراسلة', ['', 'لا توجد طلبات معلقة.']) };
  }

  const lines = ['', ...requests.map(r => `• ${r.name} (${r.id})`), '',
    'للقبول: !chats accept <thread_id>'];

  return { type: 'reply', text: box(`💬 الطلبات (${requests.length})`, lines) };
}

function showOther() {
  const others = getByCategory('other');
  if (others.length === 0) {
    return { type: 'reply', text: box('💬 أخرى', ['', 'لا توجد محادثات أخرى.']) };
  }

  const lines = ['', ...others.map(c => `• ${c.name} — ${c.messageCount} رسالة`)];
  return { type: 'reply', text: box(`💬 أخرى (${others.length})`, lines) };
}

function showSpam() {
  const spam = getByCategory('spam');
  if (spam.length === 0) {
    return { type: 'reply', text: box('💬 Spam', ['', 'لا يوجد spam.']) };
  }

  const lines = ['', ...spam.map(s => `• ${s.name} — ${s.messageCount} رسالة`)];
  return { type: 'reply', text: box(`💬 Spam (${spam.length})`, lines) };
}

function showStats() {
  const c = getChatCount();
  const total = c.groups + c.requests + c.other + c.spam;
  let totalMsgs = 0;
  for (const d of chatRegistry.values()) totalMsgs += d.messageCount || 0;

  return {
    type: 'reply',
    text: box('📊 الإحصائيات', [
      '',
      `إجمالي المحادثات: ${total}`,
      `├─ الغروبات: ${c.groups}`,
      `├─ الطلبات: ${c.requests}`,
      `├─ أخرى: ${c.other}`,
      `└─ Spam: ${c.spam}`,
      '',
      `إجمالي الرسائل: ${totalMsgs}`,
      `DM Lock: ${dmLock ? '🔒 مفعّل' : '🔓 معطّل'}`,
    ]),
  };
}

/* ── DM Lock ──────────────────────────────────────────── */

function handleDmLock(action) {
  if (!action) {
    return {
      type: 'reply',
      text: box('🔒 DM Lock', [
        '',
        `الحالة الحالية: ${dmLock ? '🔒 مفعّل' : '🔓 معطّل'}`,
        '',
        'الاستخدام:',
        '!chats dm on  → تفعيل',
        '!chats dm off → تعطيل',
      ]),
    };
  }

  const val = action.toLowerCase();
  if (val === 'on' || val === 'enable') {
    dmLock = true;
    saveChatsState();
    return { type: 'reply', text: box('🔒 DM Lock', ['', '✅ تم تفعيل القفل.', 'البوت لن يرد على الرسائل الخاصة.']) };
  }
  if (val === 'off' || val === 'disable') {
    dmLock = false;
    saveChatsState();
    return { type: 'reply', text: box('🔓 DM Lock', ['', '✅ تم تعطيل القفل.', 'البوت سيرد على الرسائل الخاصة.']) };
  }

  return { type: 'reply', text: box('❌ خطأ', ['', 'الاستخدام: !chats dm on/off']) };
}

/* ── Accept DM ────────────────────────────────────────── */

async function handleAccept(threadID, api) {
  if (!threadID) {
    return { type: 'reply', text: box('❌ خطأ', ['', 'حدد ID:', '!chats accept <thread_id>']) };
  }

  const accepted = acceptDmRequest(threadID);
  if (!accepted) {
    return { type: 'reply', text: box('❌ غير موجود', ['', `المحادثة ${threadID} ليست طلباً معلقاً.`]) };
  }

  try {
    await api.sendMessage('اهلاً وسهلاً! 👋', threadID);
  } catch {
    return {
      type: 'reply',
      text: box('⚠️ تم القبول', ['', 'تم قبول الطلب لكن فشل إرسال الترحيب.']),
    };
  }

  return {
    type: 'reply',
    text: box('✅ تم القبول', ['', `تم قبول طلب المراسلة من ${threadID}.`, 'تم إرسال الترحيب.']),
  };
}

/* ── Group Management ─────────────────────────────────── */

function handleGroupManagement(index, subParts, api) {
  const groups = getGroups();

  if (index < 0 || index >= groups.length) {
    return { type: 'reply', text: box('❌ رقم غير صحيح', ['', 'استخدم !chats list لعرض الغروبات.']) };
  }

  const group = groups[index];
  const sub = (subParts[0] || '').toLowerCase();

  // Show group management menu
  if (!sub) {
    return {
      type: 'reply',
      text: box(`💬 ${group.name}`, [
        '',
        `ID: ${group.id}`,
        `الرسائل: ${group.messageCount}`,
        `آخر رسالة: ${fmtTime(group.lastMessageAt)}`,
        '',
        '╭─── الإعدادات ─────────────────╮',
        `│ 👻 Angel: ${group.settings.angelEnabled ? '✅ ON' : '❌ OFF'}`,
        `│ 🔇 NM:    ${group.settings.nmEnabled ? '✅ ON' : '❌ OFF'}`,
        `│ ✏️ Nick:   ${group.settings.nickEnabled ? '✅ ON' : '❌ OFF'}`,
        '╰────────────────────────────────╯',
        '',
        `!chats ${index + 1} angel on/off`,
        `!chats ${index + 1} nm on/off`,
        `!chats ${index + 1} nick on/off`,
      ]),
    };
  }

  // Toggle commands
  const settings = ['angel', 'nm', 'nick'];
  const settingsMap = { angel: 'angelEnabled', nm: 'nmEnabled', nick: 'nickEnabled' };
  const emojis = { angel: '👻', nm: '🔇', nick: '✏️' };

  if (settings.includes(sub)) {
    const val = (subParts[1] || '').toLowerCase();
    if (val === 'on') {
      updateGroupSettings(group.id, settingsMap[sub], true);
      return { type: 'reply', text: box(`${emojis[sub]} ${sub.toUpperCase()}`, ['', `✅ تم تفعيل ${sub} لـ ${group.name}.`]) };
    }
    if (val === 'off') {
      updateGroupSettings(group.id, settingsMap[sub], false);
      return { type: 'reply', text: box(`${emojis[sub]} ${sub.toUpperCase()}`, ['', `✅ تم تعطيل ${sub} لـ ${group.name}.`]) };
    }
    return {
      type: 'reply',
      text: box(`${emojis[sub]} ${sub.toUpperCase()}`, [
        '',
        `الحالة: ${group.settings[settingsMap[sub]] ? '✅ ON' : '❌ OFF'}`,
        `الاستخدام: !chats ${index + 1} ${sub} on/off`,
      ]),
    };
  }

  return {
    type: 'reply',
    text: box('❌ أمر غير معروف', [
      '',
      `الأمر "${sub}" غير موجود.`,
      'المتاحة: angel, nm, nick',
      `مثال: !chats ${index + 1} angel on`,
    ]),
  };
}
