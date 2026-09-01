import { hasPermission } from './roles.js';
import { handleAddAdmin, isLevel3 } from './admin.js';
import { handleAngel } from './angel.js';
import { handleUnsend } from './unsend.js';
import { handleChats, isDmLocked } from './chats.js';

const cooldowns = new Map();

/**
 * Handle a bot command.
 * @param {object} message - FCA messageCreate event
 * @param {object} api - FCA bot API (optional, for commands that need it)
 * @returns {object} { type: 'reply'|'no_permission'|'cooldown'|'unknown'|'action', text? }
 */
export async function handleCommand(message, api) {
  const body = String(message?.body || '').trim();
  if (!body.startsWith('!')) return null;

  const [name] = body.slice(1).split(/\s+/);
  const senderID = String(message?.senderID || '');
  const cmd = name.toLowerCase();

  // ── Cooldown ───────────────────────────────────────
  const key = `${senderID}:${cmd}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < 1500) return { type: 'cooldown' };
  cooldowns.set(key, now);

  // ── DM Lock check ──────────────────────────────────
  const isGroup = message?.isGroup || message?.threadType === 'group';
  if (!isGroup && isDmLocked()) {
    return { type: 'no_permission' };
  }

  // ── !addadmin — requires admin+ permission ─────────
  if (cmd === 'addadmin') {
    // Level 3 check is done inside handleAddAdmin
    // But we still require at least admin role
    if (!hasPermission(senderID, 'admin')) {
      return { type: 'no_permission' };
    }
    return await handleAddAdmin(message, api);
  }

  // ── !angel — requires admin+ permission ────────────
  if (cmd === 'angel') {
    if (!hasPermission(senderID, 'admin')) {
      return { type: 'no_permission' };
    }
    return await handleAngel(message, api);
  }

  // ── !unsend — requires admin+ permission ───────────
  if (cmd === 'unsend') {
    if (!hasPermission(senderID, 'admin')) {
      return { type: 'no_permission' };
    }
    return await handleUnsend(message, api);
  }

  // ── !chats — requires admin+ permission ────────────
  if (cmd === 'chats') {
    if (!hasPermission(senderID, 'admin')) {
      return { type: 'no_permission' };
    }
    return await handleChats(message, api);
  }

  // ── Permission check for remaining commands ────────
  if (!hasPermission(senderID, 'admin')) {
    return { type: 'no_permission' };
  }

  // ── !ping ──────────────────────────────────────────
  if (cmd === 'ping') {
    return { type: 'reply', text: 'STAVEN BLUE V1 • pong' };
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

    const uptimeStr = parts.join(' و ');
    return {
      type: 'reply',
      text: `⏱️ STAVEN BLUE V1\nوقت التشغيل: ${uptimeStr}\nالحالة: Online`,
    };
  }

  // ── !help ──────────────────────────────────────────
  if (cmd === 'help') {
    return {
      type: 'reply',
      text: [
        '📋 STAVEN BLUE V1 Commands:',
        '',
        '!ping — Ping/pong test',
        '!uptime — Show bot uptime',
        '!addadmin — Admin level management',
        '!angel — Auto messaging system',
        '!unsend — Delete bot messages',
        '!chats — Chat/group management',
        '!help — Show this help',
      ].join('\n'),
    };
  }

  return { type: 'unknown' };
}
