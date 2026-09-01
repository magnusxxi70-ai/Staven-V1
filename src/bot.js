import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { handleCommand } from './commands.js';
import { trackBotMessage } from './unsend.js';
import { trackMessage, canReply } from './chats.js';
import { onHumanMessage, isAngelActive } from './angel.js';

let bot = null;
let botApi = null; // exported API context for commands

let botState = {
  status: 'disconnected', // connecting | connected | disconnected | error
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
};

export function getBotState() { return { ...botState }; }
export function getBotApi() { return botApi; }

export async function startBot(appStateArray) {
  // Stop existing bot first
  if (bot) { try { await stopBot(); } catch {} }

  botState.status = 'connecting';
  botState.lastError = null;

  try {
    bot = await createMessengerBot(
      { appState: appStateArray },
      { listenEvents: true, stopOnSignals: false }
    );

    botApi = bot.api || bot;

    bot.on('error', (err) => {
      console.error('[BOT] Error:', err?.message || err);
      botState.status = 'error';
      botState.lastError = new Date().toISOString();
      botState.lastDisconnected = new Date().toISOString();
    });

    bot.on('messageCreate', (event) => {
      // Use async IIFE to safely handle await inside non-async FCA callback
      (async () => {
        try {
          // Track all messages for chat management
          trackMessage(event);

          // Check if angel should respond to human messages
          const threadID = String(event?.threadID || '');
          if (threadID && event?.senderID && botState.status === 'connected') {
            const senderID = String(event.senderID);
            const botID = String(event?.botID || '');
            const isBot = senderID === '0' || senderID === botID;
            if (!isBot && isAngelActive(threadID)) {
              onHumanMessage(threadID, botApi);
            }
          }

          // Handle commands
          const result = handleCommand(event, botApi);

          if (result?.type === 'reply' && threadID) {
            const msgID = await botApi.sendMessage(result.text, threadID);
            if (msgID) trackBotMessage(threadID, msgID);
          }
          // 'action': command handled its own API calls
          // 'no_permission'/'cooldown': silently ignore
        } catch (err) {
          console.error('[BOT] Message handler error:', err?.message || err);
        }
      })();
    });

    botState.status = 'connected';
    botState.lastConnected = new Date().toISOString();
    console.log('[BOT] Connected to Facebook Messenger');
  } catch (err) {
    bot = null;
    botApi = null;
    botState.status = 'error';
    botState.lastError = new Date().toISOString();
    console.error('[BOT] Failed to start:', err?.message || err);
    throw err;
  }
}

export async function stopBot() {
  if (bot) {
    try {
      if (typeof bot.stop === 'function') bot.stop();
      else if (typeof bot.stopListening === 'function') bot.stopListening();
      else if (typeof bot.disconnect === 'function') bot.disconnect();
      else if (bot.api && typeof bot.api.stopListening === 'function') bot.api.stopListening();
      else if (bot.api && typeof bot.api.logout === 'function') bot.api.logout();
    } catch {}
    bot = null;
    botApi = null;
  }
  botState.status = 'disconnected';
  botState.lastDisconnected = new Date().toISOString();
  console.log('[BOT] Stopped');
}
