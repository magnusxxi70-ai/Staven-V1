import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

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
  appstateExists: false,
};

/* ── Persistence ────────────────────────────────────────── */

export async function loadSessionState() {
  try {
    Object.assign(state, JSON.parse(await fs.readFile(STATE_FILE, 'utf8')));
  } catch { /* no saved state yet */ }
  // Always reflect current appstate file reality
  state.appstateExists = await fileExists(APPSTATE_FILE);
  if (state.appstateExists && !state.sessionRef) {
    state.sessionRef = await maskAppstate();
  }
  return { ...state };
}

async function saveState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const toSave = { ...state };
  delete toSave.appstateExists; // derived, not persisted
  await fs.writeFile(STATE_FILE, JSON.stringify(toSave, null, 2));
  return { ...state };
}

export const getSessionState = () => ({ ...state });

/* ── File helpers ───────────────────────────────────────── */

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readAppstate() {
  try {
    return JSON.parse(await fs.readFile(APPSTATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function hashAppstate() {
  try {
    const data = await fs.readFile(APPSTATE_FILE);
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

async function maskAppstate() {
  try {
    const data = await fs.readFile(APPSTATE_FILE, 'utf8');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return '••••••' + hash.slice(-6);
  } catch {
    return null;
  }
}

/* ── Session management operations ──────────────────────── */

export async function registerSessionSubmission() {
  const now = new Date().toISOString();
  const exists = await fileExists(APPSTATE_FILE);
  state.appstateExists = exists;
  state.configured = true;
  state.status = exists ? 'configured' : 'submitted';
  state.updatedAt = now;
  state.lastCheck = now;
  state.createdAt = state.createdAt || now;
  if (exists) state.sessionRef = await maskAppstate();
  return saveState();
}

export async function replaceSession() {
  const now = new Date().toISOString();
  const exists = await fileExists(APPSTATE_FILE);
  state.appstateExists = exists;
  state.configured = true;
  state.status = exists ? 'configured' : 'submitted';
  state.updatedAt = now;
  state.lastCheck = now;
  state.lastFailedCheck = null;
  state.createdAt = state.createdAt || now;
  if (exists) state.sessionRef = await maskAppstate();
  return saveState();
}

export async function removeSession() {
  state.configured = false;
  state.status = 'not_configured';
  state.updatedAt = new Date().toISOString();
  state.lastCheck = null;
  state.lastFailedCheck = null;
  state.createdAt = null;
  state.sessionRef = null;
  state.appstateExists = false;
  return saveState();
}

export async function checkSession() {
  const now = new Date().toISOString();
  const exists = await fileExists(APPSTATE_FILE);

  if (!exists) {
    state.appstateExists = false;
    state.configured = false;
    state.status = 'not_configured';
    state.lastFailedCheck = now;
    state.lastCheck = now;
    state.updatedAt = now;
    return saveState();
  }

  // File exists — try reading it
  const data = await readAppstate();
  state.appstateExists = true;
  state.sessionRef = await maskAppstate();

  if (data === null || (typeof data === 'object' && Object.keys(data).length === 0)) {
    state.status = 'error';
    state.lastFailedCheck = now;
  } else {
    state.status = 'configured';
  }

  state.configured = true;
  state.lastCheck = now;
  state.updatedAt = now;
  return saveState();
}
