import { hasPermission } from './roles.js';
import { handleAddAdmin } from './admin.js';
import { handleAngel } from './angel.js';
import { handleUnsend } from './unsend.js';
import { handleChats, isDmLocked } from './chats.js';

const cooldowns = new Map();

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

/* ── Command Handler ──────────────────────────────────── */

export async function handleCommand(message, api) {
  const body = String(message?.body || '').trim();
  if (!body.startsWith('!')) return null;

  const [name] = body.slice(1).split(/\s+/);
  const senderID = String(message?.senderID || '');
  const cmd = name.toLowerCase();

  // Cooldown
  const key = `${senderID}:${cmd}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < 1500) return { type: 'cooldown' };
  cooldowns.set(key, now);

  // DM Lock
  const isGroup = message?.isGroup || message?.threadType === 'group';
  if (!isGroup && isDmLocked()) return { type: 'no_permission' };

  // ── !addadmin ──────────────────────────────────────
  if (cmd === 'addadmin') {
    if (!hasPermission(senderID, 'admin')) return { type: 'no_permission' };
    return await handleAddAdmin(message, api);
  }

  // ── !angel ─────────────────────────────────────────
  if (cmd === 'angel') {
    if (!hasPermission(senderID, 'admin')) return { type: 'no_permission' };
    return await handleAngel(message, api);
  }

  // ── !unsend ────────────────────────────────────────
  if (cmd === 'unsend') {
    if (!hasPermission(senderID, 'admin')) return { type: 'no_permission' };
    return await handleUnsend(message, api);
  }

  // ── !chats ─────────────────────────────────────────
  if (cmd === 'chats') {
    if (!hasPermission(senderID, 'admin')) return { type: 'no_permission' };
    return await handleChats(message, api);
  }

  // Permission check for remaining commands
  if (!hasPermission(senderID, 'admin')) return { type: 'no_permission' };

  // ── !ping ──────────────────────────────────────────
  if (cmd === 'ping') {
    return {
      type: 'reply',
      text: box('⚡ STAVEN BLUE V1', [
        '',
        '🟢 Status: Online',
        '🏓 Pong!',
        `⏱️ Uptime: ${fmtShort(process.uptime())}`,
      ]),
    };
  }

  // ── !uptime ────────────────────────────────────────
  if (cmd === 'uptime') {
    const secs = Math.floor(process.uptime());
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const parts = [];
    if (h > 0) parts.push(`${h} ساعة`);
    if (m > 0) parts.push(`${m} دقيقة`);
    if (parts.length === 0) parts.push(`${s} ثانية`);

    return {
      type: 'reply',
      text: box('⏱️ Uptime', [
        '',
        `وقت التشغيل: ${parts.join(' و ')}`,
        'الحالة: 🟢 Online',
      ]),
    };
  }

  // ── !help ──────────────────────────────────────────
  if (cmd === 'help') {
    return {
      type: 'reply',
      text: box('📋 STAVEN BLUE V1 — Commands', [
        '',
        '╭─── الأوامر ──────────────────────╮',
        '│ !ping        → فحص الاتصال       │',
        '│ !uptime      → مدة التشغيل       │',
        '│ !addadmin    → إدارة الأدمنز     │',
        '│ !angel       → رسائل تلقائية     │',
        '│ !unsend      → حذف رسائل البوت   │',
        '│ !chats       → إدارة المحادثات   │',
        '│ !help        → هذا الدليل         │',
        '╰───────────────────────────────────╯',
        '',
        '💡 جميع الأوامر تبدأ بـ !',
        '🔐 تتطلب صلاحية Admin أو أعلى',
      ]),
    };
  }

  return { type: 'unknown' };
}

/* ── Utilities ────────────────────────────────────────── */

function fmtShort(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
