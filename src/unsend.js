/**
 * !unsend — Delete bot messages
 *
 * Usage:
 *   !unsend          — Delete replied-to message or last bot message
 *   !unsend help     — Show usage
 *
 * Only deletes bot messages. Never deletes user messages.
 */

const lastBotMessages = new Map();

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

export function trackBotMessage(threadID, messageID) {
  if (threadID && messageID) lastBotMessages.set(String(threadID), String(messageID));
}

export function getLastBotMessageID(threadID) {
  return lastBotMessages.get(String(threadID)) || null;
}

/* ── Command Handler ──────────────────────────────────── */

export async function handleUnsend(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1);
  const threadID = String(message?.threadID || '');

  if (parts[0]?.toLowerCase() === 'help') {
    return {
      type: 'reply',
      text: box('🗑️ !unsend — Guide', [
        '',
        '╭─── الطريقة ────────────────────╮',
        '│ !unsend                        │',
        '│   → رد على رسالة البوت          │',
        '│   → يحذف تلك الرسالة            │',
        '│                                │',
        '│ !unsend                        │',
        '│   → بدون رد                     │',
        '│   → يحذف آخر رسالة للبوت        │',
        '╰────────────────────────────────╯',
        '',
        '⚠️ ملاحظة:',
        '• لا يحذف رسائل المستخدمين',
        '• فقط رسائل البوت فقط',
      ]),
    };
  }

  // Check if message is a reply
  let targetMessageID = null;
  if (message?.messageReply?.messageID) {
    targetMessageID = String(message.messageReply.messageID);
  }

  if (targetMessageID) {
    try {
      await api.unsend(targetMessageID);
      return {
        type: 'reply',
        text: box('🗑️ تم الحذف', ['', 'تم حذف الرسالة بنجاح. ✅']),
      };
    } catch {
      return {
        type: 'reply',
        text: box('❌ فشل الحذف', [
          '',
          'لا يمكن حذف هذه الرسالة.',
          'قد تكون رسالة مستخدم أو تم حذفها مسبقاً.',
        ]),
      };
    }
  }

  // Use last tracked bot message
  const lastID = lastBotMessages.get(threadID);
  if (!lastID) {
    return {
      type: 'reply',
      text: box('🗑️ لا توجد رسالة', ['', 'لا توجد رسالة للبوت يمكن حذفها في هذا المحادثة.']),
    };
  }

  try {
    await api.unsend(lastID);
    lastBotMessages.delete(threadID);
    return {
      type: 'reply',
      text: box('🗑️ تم الحذف', ['', 'تم حذف آخر رسالة للبوت بنجاح. ✅']),
    };
  } catch {
    return {
      type: 'reply',
      text: box('❌ فشل الحذف', ['', 'قد تكون الرسالة تم حذفها مسبقاً.']),
    };
  }
}
