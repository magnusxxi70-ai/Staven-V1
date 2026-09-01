/**
 * !unsend — Delete bot messages
 *
 * Usage:
 *   !unsend          — If reply: delete the replied-to message (must be bot's).
 *                      If no reply: delete last bot message in the thread.
 *   !unsend help     — Show usage info
 *
 * Only deletes bot messages. Never deletes user messages.
 */

// Track last bot message ID per thread: { threadId: messageId }
const lastBotMessages = new Map();

/**
 * Register a bot-sent message for later unsend.
 * Called after the bot sends any message.
 */
export function trackBotMessage(threadID, messageID) {
  if (threadID && messageID) {
    lastBotMessages.set(String(threadID), String(messageID));
  }
}

/**
 * Get the last bot message ID for a thread.
 */
export function getLastBotMessageID(threadID) {
  return lastBotMessages.get(String(threadID)) || null;
}

/**
 * Handle the !unsend command.
 * @param {object} message - FCA messageCreate event
 * @param {object} api - FCA bot API
 * @returns {object} reply object
 */
export async function handleUnsend(message, api) {
  const body = String(message?.body || '').trim();
  const parts = body.split(/\s+/).slice(1); // remove "!unsend"
  const threadID = String(message?.threadID || '');

  // !unsend help
  if (parts[0]?.toLowerCase() === 'help') {
    return {
      type: 'reply',
      text: [
        '🗑️ Usage:',
        '!unsend — Delete the bot message (reply or last sent)',
        '',
        'Reply to a bot message with !unsend to delete it.',
        'If not replying, deletes the last message the bot sent in this chat.',
      ].join('\n'),
    };
  }

  // Check if message is a reply to another message
  let targetMessageID = null;

  if (message?.messageReply?.messageID) {
    targetMessageID = String(message.messageReply.messageID);
  }

  if (targetMessageID) {
    // Unsend the replied-to message
    // Safety: FCA allows unsend only for bot's own messages.
    // If it's not the bot's message, FCA will throw an error we catch.
    try {
      await api.unsend(targetMessageID);
      return { type: 'reply', text: '✅ Message deleted.' };
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('permission') || msg.includes('not your') || msg.includes('forbidden')) {
        return {
          type: 'reply',
          text: '❌ Cannot delete this message — it\'s not the bot\'s message.',
        };
      }
      return {
        type: 'reply',
        text: '❌ Failed to delete message. It may have already been deleted or the bot lacks permission.',
      };
    }
  }

  // No reply — use last tracked bot message
  const lastID = lastBotMessages.get(threadID);
  if (!lastID) {
    return {
      type: 'reply',
      text: '❌ No bot message found to delete in this chat.',
    };
  }

  try {
    await api.unsend(lastID);
    lastBotMessages.delete(threadID);
    return { type: 'reply', text: '✅ Message deleted.' };
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('permission') || msg.includes('not your') || msg.includes('forbidden')) {
      return {
        type: 'reply',
        text: '❌ Cannot delete — the last message may not be from the bot.',
      };
    }
    return {
      type: 'reply',
      text: '❌ Failed to delete message. It may have already been deleted.',
    };
  }
}
