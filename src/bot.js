import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { handleCommand } from './commands.js';

let bot = null;
let botState = {
  status: 'disconnected', // connecting | connected | disconnected | error
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
};

export function getBotState() { return { ...botState }; }

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

    bot.on('error', (err) => {
      console.error('[BOT] Error:', err?.message || err);
      botState.status = 'error';
      botState.lastError = new Date().toISOString();
      botState.lastDisconnected = new Date().toISOString();
    });

    bot.on('messageCreate', (event) => {
      try {
        const result = handleCommand(event);
        if (result?.type === 'reply' && event?.threadID) {
          bot.api?.sendMessage(result.text, event.threadID);
        }
        // no_permission: silently ignore — do not reply
      } catch {}
    });

    botState.status = 'connected';
    botState.lastConnected = new Date().toISOString();
    console.log('[BOT] Connected to Facebook Messenger');
  } catch (err) {
    bot = null;
    botState.status = 'error';
    botState.lastError = new Date().toISOString();
    console.error('[BOT] Failed to start:', err?.message || err);
    throw err;
  }
}

export async function stopBot() {
  if (bot) {
    try {
      // Try various stop methods the FCA bot may expose
      if (typeof bot.stop === 'function') bot.stop();
      else if (typeof bot.stopListening === 'function') bot.stopListening();
      else if (typeof bot.disconnect === 'function') bot.disconnect();
      else if (bot.api && typeof bot.api.stopListening === 'function') bot.api.stopListening();
      else if (bot.api && typeof bot.api.logout === 'function') bot.api.logout();
    } catch {}
    bot = null;
  }
  botState.status = 'disconnected';
  botState.lastDisconnected = new Date().toISOString();
  console.log('[BOT] Stopped');
}
