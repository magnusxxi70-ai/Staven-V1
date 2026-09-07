import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');

const { createMessengerBot } = fca;

import {
  hasPermission,
  getUserRole
} from './roles.js';

import {
  handleStavenCommand,
  initStavenPrivate,
  cleanupStavenPrivate,
  isMessageProcessed,
  markMessageProcessed
} from './stavenPrivateAutoReply.js';

import {
  handleSuperAdminCommand,
  loadSuperAdmins
} from './stavenSuperAdminManager.js';

import {
  handleStavenChat,
  handleChatReply,
  loadChatState
} from './stavenChat.js';

/* =========================================================
   STAVEN BLUE V1 — BOT CORE
   MQTT / CONNECTION STABILITY PATCH
   ========================================================= */

let bot = null;
let botApi = null;

let botState = {
  status: 'disconnected',
  lastConnected: null,
  lastDisconnected: null,
  lastError: null
};

let currentBotID = '';

/* =========================================================
   STATE
   ========================================================= */

export function getBotState() {
  return { ...botState };
}

export function getBotApi() {
  return botApi;
}

/* =========================================================
   HELPERS
   ========================================================= */

function log(message) {
  console.log(`[STAVEN] ${message}`);
}

function setError(err, source = 'BOT') {
  const message =
    err?.message ||
    err?.reason ||
    String(err || 'Unknown error');

  botState.status = 'error';
  botState.lastError = new Date().toISOString();
  botState.lastDisconnected = new Date().toISOString();

  console.error(`[${source}] ${message}`);
}

async function safeStop(instance) {
  if (!instance) return;

  try {
    if (typeof instance.stop === 'function') {
      await instance.stop();
      return;
    }

    if (typeof instance.stopListening === 'function') {
      await instance.stopListening();
      return;
    }

    if (typeof instance.disconnect === 'function') {
      await instance.disconnect();
      return;
    }

    if (
      instance.api &&
      typeof instance.api.stopListening === 'function'
    ) {
      await instance.api.stopListening();
      return;
    }
  } catch (err) {
    console.error(
      '[BOT] Stop error:',
      err?.message || err
    );
  }
}

/* =========================================================
   BOT START
   ========================================================= */

export async function startBot(appStateArray) {
  /*
   * Always stop the previous instance first.
   * This prevents duplicate MQTT connections.
   */
  if (bot) {
    try {
      await stopBot();
    } catch {}
  }

  bot = null;
  botApi = null;
  currentBotID = '';

  botState.status = 'connecting';
  botState.lastError = null;

  log('Starting Messenger connection...');
  log('MQTT automatic reconnect: ENABLED');

  try {
    /*
     * IMPORTANT:
     *
     * autoReconnect:
     *   Lets FCA reconnect MQTT after a disconnect.
     *
     * emitReady:
     *   Lets us detect when MQTT becomes ready.
     *
     * listenEvents:
     *   Required for Messenger events/messages.
     *
     * selfListen:
     *   Keeps the existing STAVEN behaviour.
     */
    bot = await createMessengerBot(
      {
        appState: appStateArray
      },
      {
        listenEvents: true,
        stopOnSignals: false,
        selfListen: true,

        autoReconnect: true,
        emitReady: true,

        logLevel: 'info'
      }
    );

    botApi = bot.api || bot;

    log('FCA MessengerBot initialized.');

    /* =====================================================
       CONNECTION EVENTS
       ===================================================== */

    /*
     * MQTT / Messenger ready event.
     */
    if (typeof bot.on === 'function') {
      bot.on('ready', () => {
        botState.status = 'connected';
        botState.lastConnected =
          new Date().toISOString();

        botState.lastError = null;

        log('MQTT READY');
        log('Connected to Facebook Messenger.');
      });

      /*
       * General bot error.
       */
      bot.on('error', (err) => {
        const message =
          err?.message ||
          err?.reason ||
          String(err || 'Unknown error');

        console.error(
          '[BOT] Error:',
          message
        );

        /*
         * Do not destroy the bot here.
         *
         * FCA has autoReconnect enabled.
         * Destroying the instance on every MQTT error
         * would fight against FCA's own reconnect system.
         */
        botState.status = 'error';
        botState.lastError =
          new Date().toISOString();

        /*
         * If FCA reports the connection refusal,
         * keep the instance alive so its reconnect
         * mechanism can work.
         */
        if (
          message.toLowerCase().includes('mqtt') ||
          message.toLowerCase().includes('connection refused') ||
          message.toLowerCase().includes('disconnect')
        ) {
          log(
            'MQTT connection problem detected. ' +
            'Waiting for automatic FCA reconnect...'
          );
        }
      });

      /*
       * Some FCA versions emit disconnect.
       */
      bot.on('disconnect', (reason) => {
        botState.status = 'connecting';
        botState.lastDisconnected =
          new Date().toISOString();

        console.warn(
          '[BOT] MQTT disconnected:',
          reason || 'unknown reason'
        );

        log(
          'Waiting for automatic MQTT reconnect...'
        );
      });
    }

    /* =====================================================
       BOT ID
       ===================================================== */

    try {
      if (
        typeof botApi.getCurrentUserID ===
        'function'
      ) {
        currentBotID = String(
          await botApi.getCurrentUserID()
        );
      }
    } catch (err) {
      console.warn(
        '[BOT] Could not read Bot ID:',
        err?.message || err
      );
    }

    console.log(
      `[BOT] Bot ID: ${
        currentBotID || '(unknown)'
      }`
    );

    /* =====================================================
       STAVEN PRIVATE AUTO REPLY
       ===================================================== */

    const sendFn = async (msg, threadID) => {
      if (!botApi) {
        throw new Error(
          'Messenger API is not available'
        );
      }

      return await botApi.sendMessage(
        msg,
        threadID
      );
    };

    await initStavenPrivate(
      sendFn,
      getUserRole
    );

    /* =====================================================
       SUPER ADMIN
       ===================================================== */

    await loadSuperAdmins();

    /* =====================================================
       STAVEN CHAT
       ===================================================== */

    await loadChatState();

    /* =====================================================
       MESSAGE HANDLER
       ===================================================== */

    bot.on(
      'messageCreate',
      async (event) => {
        try {
          const body =
            String(event?.body || '').trim();

          const threadID =
            String(event?.threadID || '');

          const senderID =
            String(event?.senderID || '');

          const messageID =
            String(event?.messageID || '');

          if (!threadID) return;

          /* ===============================================
             MESSAGE DEDUPLICATION
             =============================================== */

          if (
            messageID &&
            isMessageProcessed(messageID)
          ) {
            return;
          }

          if (messageID) {
            markMessageProcessed(messageID);
          }

          /* ===============================================
             MESSAGE SOURCE
             =============================================== */

          const isBotMsg =
            senderID === '0' ||
            (
              currentBotID &&
              senderID === currentBotID
            );

          const sendMessage = async (
            msg,
            tid
          ) => {
            if (!botApi) return;

            return await botApi.sendMessage(
              msg,
              tid
            );
          };

          const checkPerm = async (
            uid,
            level
          ) => {
            if (
              currentBotID &&
              uid === currentBotID
            ) {
              return true;
            }

            return hasPermission(
              uid,
              level
            );
          };

          /* ===============================================
             BOT'S OWN MESSAGES
             =============================================== */

          if (isBotMsg) {
            if (
              body.startsWith('!ستافين')
            ) {
              if (
                await handleStavenCommand(
                  event,
                  sendMessage,
                  {
                    isBotMsg: true,
                    botID: currentBotID
                  }
                )
              ) {
                return;
              }

              if (
                await handleStavenChat(
                  event,
                  sendMessage,
                  botApi,
                  checkPerm
                )
              ) {
                return;
              }

              if (
                await handleSuperAdminCommand(
                  event,
                  sendMessage,
                  checkPerm
                )
              ) {
                return;
              }
            }

            /*
             * Ignore other bot messages.
             * Prevents auto-reply loops.
             */
            return;
          }

          /* ===============================================
             HUMAN MESSAGE
             =============================================== */

          /*
           * STAVEN commands
           */
          if (
            body.startsWith('!ستافين')
          ) {
            if (
              await handleStavenCommand(
                event,
                sendMessage,
                {
                  isBotMsg: false,
                  botID: currentBotID
                }
              )
            ) {
              return;
            }

            if (
              await handleStavenChat(
                event,
                sendMessage,
                botApi,
                checkPerm
              )
            ) {
              return;
            }

            if (
              await handleSuperAdminCommand(
                event,
                sendMessage,
                checkPerm
              )
            ) {
              return;
            }
          }

          /* ===============================================
             STAVEN CHAT REPLY
             =============================================== */

          if (
            await handleChatReply(
              event,
              sendMessage,
              botApi,
              checkPerm
            )
          ) {
            return;
          }

          /* ===============================================
             NORMAL COMMANDS
             =============================================== */

          if (!body.startsWith('!')) {
            return;
          }

          const cmd =
            body
              .split(/\s+/)[0]
              .toLowerCase();

          /* ===============================================
             UPTIME
             =============================================== */

          if (cmd === '!uptime') {
            if (
              !await checkPerm(
                senderID,
                'admin'
              )
            ) {
              return;
            }

            const totalSec =
              Math.floor(
                process.uptime()
              );

            const days =
              Math.floor(
                totalSec / 86400
              );

            const hours =
              Math.floor(
                (totalSec % 86400) /
                3600
              );

            const minutes =
              Math.floor(
                (totalSec % 3600) /
                60
              );

            const seconds =
              totalSec % 60;

            const bar =
              '─'.repeat(32);

            const msg = [
              `╭${bar}╮`,
              '│ ⚡ STAVEN BLUE V1',
              '│',
              '│ ⏱️ مدة التشغيل:',
              `│ 📅 الأيام: ${days}`,
              `│ 🕐 الساعات: ${hours}`,
              `│ ⏳ الدقائق: ${minutes}`,
              `│ ⚡ الثواني: ${seconds}`,
              '│',
              '│ 🤖 النظام: Staven Blue V1',
              '│ 👑 المطور: Magnus',
              '│',
              `╰${bar}╯`
            ].join('\n');

            try {
              await botApi.sendMessage(
                msg,
                threadID
              );
            } catch (err) {
              console.error(
                '[BOT] Uptime send error:',
                err?.message || err
              );
            }
          }

        } catch (err) {
          console.error(
            '[MESSAGE] Handler error:',
            err?.message || err
          );
        }
      }
    );

    /*
     * IMPORTANT:
     *
     * Do NOT immediately treat the connection as
     * MQTT-ready if FCA has not emitted ready yet.
     *
     * createMessengerBot may finish initialization
     * before realtime MQTT is fully ready.
     */
    if (
      typeof bot.on !== 'function'
    ) {
      botState.status = 'connected';
      botState.lastConnected =
        new Date().toISOString();
    } else {
      /*
       * The MessengerBot object exists.
       * MQTT may still be connecting.
       */
      botState.status = 'connecting';
    }

    console.log(
      '[BOT] MessengerBot initialized successfully.'
    );

    return bot;

  } catch (err) {
    bot = null;
    botApi = null;
    currentBotID = '';

    botState.status = 'error';
    botState.lastError =
      new Date().toISOString();

    console.error(
      '[BOT] Failed to start:',
      err?.message || err
    );

    throw err;
  }
}

/* =========================================================
   STOP BOT
   ========================================================= */

export async function stopBot() {
  cleanupStavenPrivate();

  const instance = bot;

  bot = null;
  botApi = null;
  currentBotID = '';

  if (instance) {
    await safeStop(instance);
  }

  botState.status = 'disconnected';
  botState.lastDisconnected =
    new Date().toISOString();

  console.log(
    '[BOT] Stopped.'
  );
              }
