/**
 * !addadmin — Admin level management system
 *
 * Levels:
 *   Lv1 = Junior
 *   Lv2 = Admin
 *   Lv3 = Senior Admin / Top Admin
 *
 * Usage:
 *   !addadmin <level> <user_id>     — Add user at level
 *   !addadmin <level>               — Add replied-to user at level
 *   !addadmin list                  — List all admins
 *   !addadmin list <level>          — List admins at level
 *   !addadmin remove <user_id>      — Remove admin
 *   !addadmin remove                — Remove replied-to admin
 *
 * Only Level 3 can add/modify/remove admins.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ADMIN_FILE = path.resolve('data/admin-levels.json');

const LEVELS = {
  1: 'Junior',
  2: 'Admin',
  3: 'Senior Admin',
};

const MAX_LEVEL = 3;
const MIN_LEVEL = 1;

// In-memory store: { userId: levelNumber }
let adminLevels = {};

export async function loadAdminLevels() {
  try {
    const saved = JSON.parse(await fs.readFile(ADMIN_FILE, 'utf8'));
    if (saved && typeof saved === 'object') adminLevels = saved;
  } catch { /* no saved state */ }
  return { ...adminLevels };
}

export function getAdminLevels() {
  return { ...adminLevels };
}

export function getAdminLevel(userId) {
  if (!userId) return 0;
  return adminLevels[String(userId).trim()] || 0;
}

export function isLevel3(userId) {
  return getAdminLevel(userId) >= 3;
}

async function saveAdminLevels() {
  await fs.mkdir(path.dirname(ADMIN_FILE), { recursive: true });
  await fs.writeFile(ADMIN_FILE, JSON.stringify(adminLevels, null, 2));
}

/**
 * Handle the !addadmin command.
 * @param {object} message - FCA messageCreate event
 * @param {object} api - FCA bot API
 * @returns {object} reply object
 */
export async function handleAddAdmin(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1); // remove "!addadmin"
  const sub = (parts[0] || '').toLowerCase();
  const senderID = String(message?.senderID || '');

  // Check permission: must be Level 3
  if (!isLevel3(senderID)) {
    return {
      type: 'reply',
      text: '⛔ This command requires Level 3 (Senior Admin) access.',
    };
  }

  // !addadmin list [level]
  if (sub === 'list') {
    return handleList(parts.slice(1));
  }

  // !addadmin remove [user_id]
  if (sub === 'remove') {
    return await handleRemove(parts.slice(1), message);
  }

  // !addadmin <level> [user_id]
  if (!sub) {
    return {
      type: 'reply',
      text: [
        '📋 Usage:',
        '!addadmin <1|2|3> <user_id> — Add user',
        '!addadmin <1|2|3> — Add replied-to user',
        '!addadmin list — List all admins',
        '!addadmin list <level> — List by level',
        '!addadmin remove <user_id> — Remove admin',
      ].join('\n'),
    };
  }

  // Parse level
  const level = parseInt(sub, 10);
  if (isNaN(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    return {
      type: 'reply',
      text: `❌ Invalid level: "${sub}". Use 1, 2, or 3.`,
    };
  }

  // Parse user ID
  let targetID = parts[1];

  // If no ID provided, try reply
  if (!targetID) {
    targetID = extractReplyUserID(message);
    if (!targetID) {
      return {
        type: 'reply',
        text: '❌ No user specified. Reply to a message or provide a User ID:\n!addadmin <1|2|3> <user_id>',
      };
    }
  }

  return await assignLevel(targetID, level, senderID);
}

function extractReplyUserID(message) {
  // Try standard FCA reply format
  if (message?.messageReply?.senderID) {
    return String(message.messageReply.senderID);
  }
  // Try mentions (first mention)
  if (message?.mentions && Object.keys(message.mentions).length > 0) {
    return Object.keys(message.mentions)[0];
  }
  return null;
}

function parseUserID(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  // If it starts with @, it's a mention - try to extract the ID
  if (cleaned.startsWith('@')) {
    // In FCA, mentions come as "Name" -> ID in message.mentions
    // This won't work from plain text, so return null for bare @mentions
    return null;
  }
  // Basic validation: should be numeric
  if (/^\d{5,}$/.test(cleaned)) return cleaned;
  return null;
}

async function assignLevel(targetID, level, assignerID) {
  const prev = adminLevels[targetID];
  adminLevels[targetID] = level;
  await saveAdminLevels();

  const levelName = LEVELS[level];
  if (prev && prev !== level) {
    return {
      type: 'reply',
      text: `✅ User ${targetID} upgraded from Lv${prev} (${LEVELS[prev]}) to Lv${level} (${levelName}).`,
    };
  }
  return {
    type: 'reply',
    text: `✅ User ${targetID} added as Lv${level} (${levelName}).`,
  };
}

function handleList(levelArgs) {
  const level = levelArgs[0] ? parseInt(levelArgs[0], 10) : null;
  const entries = Object.entries(adminLevels);

  if (entries.length === 0) {
    return { type: 'reply', text: '📋 No admins registered yet.' };
  }

  const filtered = level
    ? entries.filter(([, l]) => l === level)
    : entries;

  if (filtered.length === 0) {
    return {
      type: 'reply',
      text: level
        ? `📋 No admins at Level ${level}.`
        : '📋 No admins registered yet.',
    };
  }

  const lines = filtered
    .sort((a, b) => b[1] - a[1]) // highest level first
    .map(([id, lvl]) => `• ${id} — Lv${lvl} (${LEVELS[lvl]})`);

  const header = level
    ? `📋 Level ${level} (${LEVELS[level]}):`
    : '📋 All Admins:';

  return { type: 'reply', text: [header, ...lines].join('\n') };
}

async function handleRemove(parts, message) {
  let targetID = parts[0] || null;

  if (!targetID) {
    targetID = extractReplyUserID(message);
    if (!targetID) {
      return {
        type: 'reply',
        text: '❌ No user specified. Reply to a message or provide a User ID:\n!addadmin remove <user_id>',
      };
    }
  }

  const cleaned = String(targetID).trim();
  if (!adminLevels[cleaned]) {
    return {
      type: 'reply',
      text: `❌ User ${cleaned} is not a registered admin.`,
    };
  }

  const prevLevel = adminLevels[cleaned];
  delete adminLevels[cleaned];
  await saveAdminLevels();

  return {
    type: 'reply',
    text: `✅ User ${cleaned} removed from Lv${prevLevel} (${LEVELS[prevLevel]}).`,
  };
}
