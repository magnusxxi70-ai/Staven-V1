/**
 * !addadmin — Admin level management system
 *
 * Levels:
 *   Lv1 = Junior
 *   Lv2 = Admin
 *   Lv3 = Senior Admin / Top Admin
 *
 * Only Level 3 can add/modify/remove admins.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ADMIN_FILE = path.resolve('data/admin-levels.json');

const LEVELS = { 1: 'Junior', 2: 'Admin', 3: 'Senior Admin' };
const LEVEL_EMOJI = { 1: '🟢', 2: '🔵', 3: '🟡' };
const MAX_LEVEL = 3;
const MIN_LEVEL = 1;

let adminLevels = {};

/* ── Persistence ──────────────────────────────────────── */

export async function loadAdminLevels() {
  try {
    const saved = JSON.parse(await fs.readFile(ADMIN_FILE, 'utf8'));
    if (saved && typeof saved === 'object') adminLevels = saved;
  } catch {}
  return { ...adminLevels };
}

async function save() {
  await fs.mkdir(path.dirname(ADMIN_FILE), { recursive: true });
  await fs.writeFile(ADMIN_FILE, JSON.stringify(adminLevels, null, 2));
}

export function getAdminLevels() { return { ...adminLevels }; }
export function getAdminLevel(userId) { return userId ? (adminLevels[String(userId).trim()] || 0) : 0; }
export function isLevel3(userId) { return getAdminLevel(userId) >= 3; }

/* ── Helpers ──────────────────────────────────────────── */

function extractUserID(message) {
  if (message?.messageReply?.senderID) return String(message.messageReply.senderID);
  if (message?.mentions && Object.keys(message.mentions).length > 0) return Object.keys(message.mentions)[0];
  return null;
}

function box(title, lines) {
  const w = 34;
  const border = '─'.repeat(w);
  return [
    `╭${border}╮`,
    `│ ${title}`,
    `╰${border}╯`,
    ...lines,
    '─'.repeat(w + 2),
  ].join('\n');
}

/* ── Command Handler ──────────────────────────────────── */

export async function handleAddAdmin(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1);
  const sub = (parts[0] || '').toLowerCase();
  const senderID = String(message?.senderID || '');

  if (!isLevel3(senderID)) {
    return {
      type: 'reply',
      text: box('⛔ Access Denied', [
        '',
        'هذا الأمر مخصص لـ Level 3 فقط.',
        'Level 3 = Senior Admin / Top Admin',
        '',
        'مستوى صلاحياتك الحالي: Lv' + getAdminLevel(senderID),
      ]),
    };
  }

  if (sub === 'list') return handleList(parts.slice(1));
  if (sub === 'remove') return await handleRemove(parts.slice(1), message);

  if (!sub || sub === 'help') {
    return {
      type: 'reply',
      text: box('📋 !addadmin — Guide', [
        '',
        '╭─── الإضافة ───────────────╮',
        '│ !addadmin 1 @user         │',
        '│ !addadmin 2 <ID>          │',
        '│ !addadmin 3 <ID>          │',
        '│ !addadmin 2 (رد على رسالة)│',
        '╰───────────────────────────╯',
        '',
        '╭─── الإدارة ───────────────╮',
        '│ !addadmin list            │',
        '│ !addadmin list 2          │',
        '│ !addadmin remove <ID>     │',
        '│ !addadmin remove (رد)     │',
        '╰───────────────────────────╯',
        '',
        'المستويات:',
        '  🟢 Lv1 = Junior',
        '  🔵 Lv2 = Admin',
        '  🟡 Lv3 = Senior Admin',
      ]),
    };
  }

  const level = parseInt(sub, 10);
  if (isNaN(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    return {
      type: 'reply',
      text: box('❌ خطأ', [
        '',
        `المستوى "${sub}" غير صحيح.`,
        'استخدم: 1 أو 2 أو 3',
      ]),
    };
  }

  let targetID = parts[1];
  if (!targetID) {
    targetID = extractUserID(message);
    if (!targetID) {
      return {
        type: 'reply',
        text: box('❌ لم يتم تحديد مستخدم', [
          '',
          'رد على رسالة المستخدم أو',
          'أدخل User ID:',
          `!addadmin ${level} <user_id>`,
        ]),
      };
    }
  }

  return await assignLevel(targetID, level);
}

async function assignLevel(targetID, level) {
  const prev = adminLevels[targetID];
  adminLevels[targetID] = level;
  await save();

  const emoji = LEVEL_EMOJI[level];
  const name = LEVELS[level];

  if (prev && prev !== level) {
    return {
      type: 'reply',
      text: box('✅ تم الترقية', [
        '',
        `المستخدم: ${targetID}`,
        `من: Lv${prev} (${LEVELS[prev]})`,
        `إلى: ${emoji} Lv${level} (${name})`,
      ]),
    };
  }

  return {
    type: 'reply',
    text: box('✅ تم الإضافة', [
      '',
      `المستخدم: ${targetID}`,
      `ال级别: ${emoji} Lv${level} (${name})`,
    ]),
  };
}

function handleList(levelArgs) {
  const level = levelArgs[0] ? parseInt(levelArgs[0], 10) : null;
  const entries = Object.entries(adminLevels);

  if (entries.length === 0) {
    return {
      type: 'reply',
      text: box('📋 قائمة الأدمنز', ['', 'لا يوجد أي أدمن مسجل حالياً.']),
    };
  }

  const filtered = level ? entries.filter(([, l]) => l === level) : entries;

  if (filtered.length === 0) {
    return {
      type: 'reply',
      text: box('📋 قائمة الأدمنز', ['', `لا يوجد أدمنز في المستوى ${level}.`]),
    };
  }

  const lines = ['', ...filtered
    .sort((a, b) => b[1] - a[1])
    .map(([id, lvl]) => `${LEVEL_EMOJI[lvl]} Lv${lvl} — ${id}`),
  ];

  const title = level
    ? `📋 المستوى ${level} (${LEVELS[level]})`
    : '📋 جميع الأدمنز';

  return { type: 'reply', text: box(title, lines) };
}

async function handleRemove(parts, message) {
  let targetID = parts[0] || null;
  if (!targetID) {
    targetID = extractUserID(message);
    if (!targetID) {
      return {
        type: 'reply',
        text: box('❌ لم يتم تحديد مستخدم', [
          '',
          'رد على رسالة المستخدم أو',
          'أدخل User ID:',
          '!addadmin remove <user_id>',
        ]),
      };
    }
  }

  const cleaned = String(targetID).trim();
  if (!adminLevels[cleaned]) {
    return {
      type: 'reply',
      text: box('❌ غير موجود', [
        '',
        `المستخدم ${cleaned} ليس أدمناً مسجلاً.`,
      ]),
    };
  }

  const prevLevel = adminLevels[cleaned];
  delete adminLevels[cleaned];
  await save();

  return {
    type: 'reply',
    text: box('🗑️ تم الإزالة', [
      '',
      `المستخدم: ${cleaned}`,
      `كان في: Lv${prevLevel} (${LEVELS[prevLevel]})`,
    ]),
  };
}
