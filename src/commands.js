import { hasPermission } from './roles.js';

const cooldowns = new Map();

export function handleCommand(message) {
  const body = String(message?.body || '').trim();
  if (!body.startsWith('!')) return null;

  const [name] = body.slice(1).split(/\s+/);
  const senderID = String(message?.senderID || '');

  const key = `${senderID}:${name.toLowerCase()}`;
  const now = Date.now();

  if (now - (cooldowns.get(key) || 0) < 1500) return { type: 'cooldown' };
  cooldowns.set(key, now);

  // ── Permission check ──────────────────────────────────
  if (!hasPermission(senderID, 'admin')) {
    return { type: 'no_permission' };
  }

  if (name.toLowerCase() === 'ping') {
    return { type: 'reply', text: 'STAVEN BLUE V1 • pong' };
  }

  if (name.toLowerCase() === 'uptime') {
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
      text: `⏱️ STAVEN BLUE V1\nوقت التشغيل: ${uptimeStr}\nالحالة: Online`
    };
  }

  if (name.toLowerCase() === 'help') {
    return { type: 'reply', text: '!ping\n!uptime\n!help' };
  }

  return { type: 'unknown' };
}
