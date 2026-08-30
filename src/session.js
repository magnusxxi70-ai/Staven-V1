import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startBot, stopBot, getBotState } from './bot.js';

const STATE_FILE = path.resolve('data/session-state.json');
const APPSTATE_FILE = path.resolve('data/appstate.json');

const state = {
  configured: false,
  status: 'not_configured',
  updatedAt: null,
  lastCheck: null,
  lastFailedCheck: null,
  createdAt: null,
  sessionRef: null,
};

/* ── Persistence ────────────────────────────────────────── */

export async function loadSessionState() {
  try {
    Object.assign(state, JSON.parse(await fs.readFile(STATE_FILE, 'utf8')));
  } catch { /* no saved state yet */ }

  // Try to auto-start bot if appstate exists on disk
  if (state.configured) {
    try {
      const appState = await loadAppstateFromDisk();
      if (appState && appState.length > 0) {
        await startBot(appState);
      }
    } catch (e) {
      console.error('[SESSION] Auto-start bot failed:', e?.message);
      state.status = 'error';
    }
  }

  return { ...state };
}

async function saveState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return { ...state };
}

export function getSessionState() {
  const bot = getBotState();
  return {
    ...state,
    botStatus: bot.status,
    lastConnected: bot.lastConnected,
    lastDisconnected: bot.lastDisconnected,
    lastBotError: bot.lastError,
  };
}

/* ── File helpers ───────────────────────────────────────── */

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function loadAppstateFromDisk() {
  try {
    const raw = await fs.readFile(APPSTATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function maskRef(data) {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return '\u2022\u2022\u2022\u2022\u2022\u2022' + hash.slice(-6);
  } catch {
    return null;
  }
}

function parseAppStateInput(input) {
  if (!input) return null;

  // Already parsed (array or object from JSON body)
  if (Array.isArray(input)) return input.length > 0 ? input : null;
  if (input && typeof input === 'object' && Array.isArray(input.appState)) {
    return input.appState.length > 0 ? input.appState : null;
  }

  // String input
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Try JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.appState)) {
      return parsed.appState.length > 0 ? parsed.appState : null;
    }
    return null;
  } catch {}

  // Raw cookie string: "c_user=...; xs=..."
  if (trimmed.includes('=') && trimmed.includes(';')) {
    return trimmed;
  }

  return null;
}

async function writeAppstate(data) {
  await fs.mkdir(path.dirname(APPSTATE_FILE), { recursive: true });
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await fs.writeFile(APPSTATE_FILE, str, 'utf8');
}

async function deleteAppstate() {
  try { await fs.unlink(APPSTATE_FILE); } catch {}
}

/* ── Session management operations ──────────────────────── */

export async function registerSession(appStateInput) {
  const parsed = parseAppStateInput(appStateInput);
  if (!parsed) {
    return { ...state, error: 'Invalid appstate data. Provide a JSON array of cookies or a raw cookie string.' };
  }

  const now = new Date().toISOString();
  await writeAppstate(parsed);

  state.configured = true;
  state.status = 'connecting';
  state.updatedAt = now;
  state.lastCheck = now;
  state.createdAt = state.createdAt || now;
  state.lastFailedCheck = null;
  state.sessionRef = maskRef(parsed);
  await saveState();

  // Start bot
  try {
    await startBot(parsed);
    state.status = 'connected';
  } catch (e) {
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = e?.message || 'Failed to connect';
  }
  state.updatedAt = new Date().toISOString();
  await saveState();
  return { ...state };
}

export async function replaceSession(appStateInput) {
  const parsed = parseAppStateInput(appStateInput);
  if (!parsed) {
    return { ...state, error: 'Invalid appstate data. Provide a JSON array of cookies or a raw cookie string.' };
  }

  const now = new Date().toISOString();
  await writeAppstate(parsed);

  state.configured = true;
  state.status = 'connecting';
  state.updatedAt = now;
  state.lastCheck = now;
  state.lastFailedCheck = null;
  state.error = null;
  state.createdAt = state.createdAt || now;
  state.sessionRef = maskRef(parsed);
  await saveState();

  // Restart bot with new appstate
  try {
    await startBot(parsed);
    state.status = 'connected';
  } catch (e) {
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = e?.message || 'Failed to connect';
  }
  state.updatedAt = new Date().toISOString();
  await saveState();
  return { ...state };
}

export async function removeSession() {
  await stopBot();
  await deleteAppstate();

  state.configured = false;
  state.status = 'not_configured';
  state.updatedAt = new Date().toISOString();
  state.lastCheck = null;
  state.lastFailedCheck = null;
  state.createdAt = null;
  state.sessionRef = null;
  state.error = null;
  await saveState();
  return { ...state };
}

export async function checkSession() {
  const now = new Date().toISOString();
  const exists = await fileExists(APPSTATE_FILE);

  if (!exists) {
    state.configured = false;
    state.status = 'not_configured';
    state.lastFailedCheck = now;
    state.lastCheck = now;
    state.updatedAt = now;
    await saveState();
    return { ...state };
  }

  const appState = await loadAppstateFromDisk();
  state.sessionRef = appState ? maskRef(appState) : null;
  state.lastCheck = now;
  state.updatedAt = now;

  if (!appState || (Array.isArray(appState) && appState.length === 0)) {
    state.status = 'error';
    state.lastFailedCheck = now;
    state.configured = false;
    state.error = 'Appstate file is empty or invalid';
  } else {
    // Try to (re)start the bot
    state.configured = true;
    state.status = 'connecting';
    await saveState();
    try {
      await startBot(appState);
      state.status = 'connected';
      state.error = null;
    } catch (e) {
      state.status = 'error';
      state.lastFailedCheck = now;
      state.error = e?.message || 'Connection failed';
    }
  }

  await saveState();
  return { ...state };
}
