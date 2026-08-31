import fs from 'node:fs/promises';
import path from 'node:path';

const ROLES_FILE = path.resolve('data/roles.json');

const LIMITS = {
  owner: 1,
  superAdmin: 15,
  admin: 20,
};

// Hierarchy: higher number = more powerful
const ROLE_LEVEL = { admin: 1, superAdmin: 2, owner: 3 };

const roles = {
  owner: [],      // max 1
  superAdmins: [], // max 15
  admins: [],     // max 20
};

/* ── Persistence ───────────────────────────────────────── */

export async function loadRoles() {
  try {
    const saved = JSON.parse(await fs.readFile(ROLES_FILE, 'utf8'));
    if (saved.owner) roles.owner = saved.owner;
    if (saved.superAdmins) roles.superAdmins = saved.superAdmins;
    if (saved.admins) roles.admins = saved.admins;
  } catch { /* no saved state yet */ }
  return getRoles();
}

async function saveRoles() {
  await fs.mkdir(path.dirname(ROLES_FILE), { recursive: true });
  await fs.writeFile(ROLES_FILE, JSON.stringify(roles, null, 2));
}

/* ── Read-only accessors ───────────────────────────────── */

export function getRoles() {
  return {
    owner: [...roles.owner],
    superAdmins: [...roles.superAdmins],
    admins: [...roles.admins],
  };
}

/**
 * Get a user's role name or null.
 */
export function getUserRole(userId) {
  if (!userId) return null;
  const id = String(userId).trim();
  if (roles.owner.includes(id)) return 'owner';
  if (roles.superAdmins.includes(id)) return 'superAdmin';
  if (roles.admins.includes(id)) return 'admin';
  return null;
}

/**
 * Check if user has at least the given minimum role level.
 * 'owner' > 'superAdmin' > 'admin'
 */
export function hasPermission(userId, minLevel = 'admin') {
  const role = getUserRole(userId);
  if (!role) return false;
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minLevel] || 0);
}

/* ── Mutation operations (apply/pending) ───────────────── */

/**
 * Stage changes. Returns a snapshot of what would change.
 * caller must call commitPendingRoles to actually save.
 */
let pendingRoles = null;

export function getPendingRoles() {
  return pendingRoles ? { ...pendingRoles } : null;
}

export function stageRoles(newRoles) {
  // Validate structure
  if (!newRoles || typeof newRoles !== 'object') return { ok: false, error: 'Invalid roles data' };

  const staged = {
    owner: [],
    superAdmins: [],
    admins: [],
  };

  // Process owner (max 1)
  if (newRoles.owner && Array.isArray(newRoles.owner)) {
    if (newRoles.owner.length > LIMITS.owner) {
      return { ok: false, error: `Owner limit exceeded. Maximum: ${LIMITS.owner}` };
    }
    staged.owner = newRoles.owner.map(String).filter(Boolean);
  }

  // Process superAdmins (max 15)
  if (newRoles.superAdmins && Array.isArray(newRoles.superAdmins)) {
    if (newRoles.superAdmins.length > LIMITS.superAdmin) {
      return { ok: false, error: `Super Admin limit exceeded. Maximum: ${LIMITS.superAdmin}` };
    }
    staged.superAdmins = newRoles.superAdmins.map(String).filter(Boolean);
  }

  // Process admins (max 20)
  if (newRoles.admins && Array.isArray(newRoles.admins)) {
    if (newRoles.admins.length > LIMITS.admins) {
      return { ok: false, error: `Admin limit exceeded. Maximum: ${LIMITS.admins}` };
    }
    staged.admins = newRoles.admins.map(String).filter(Boolean);
  }

  // Check for duplicates across all roles
  const allIds = [...staged.owner, ...staged.superAdmins, ...staged.admins];
  const seen = new Set();
  for (const id of allIds) {
    if (seen.has(id)) {
      return { ok: false, error: `Duplicate User ID: ${id}. A user can only have one role.` };
    }
    seen.add(id);
  }

  pendingRoles = staged;
  return { ok: true, staged };
}

export async function commitPendingRoles() {
  if (!pendingRoles) return { ok: false, error: 'No pending changes to save' };

  roles.owner = [...pendingRoles.owner];
  roles.superAdmins = [...pendingRoles.superAdmins];
  roles.admins = [...pendingRoles.admins];

  await saveRoles();

  const result = { ...roles };
  pendingRoles = null;
  return { ok: true, roles: result };
}

export function discardPendingRoles() {
  pendingRoles = null;
  return { ok: true };
}

/* ── Convenience: add/remove single user (stages only) ── */

export function addUserToStage(userId, role) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  // Start from current roles + pending
  const base = pendingRoles || { ...roles, owner: [...roles.owner], superAdmins: [...roles.superAdmins], admins: [...roles.admins] };

  // Check user not already in another role
  const existingRole = findUserRoleInSnapshot(base, id);
  if (existingRole && existingRole !== role) {
    return { ok: false, error: `User ${id} is already assigned as ${existingRole}. Remove them first.` };
  }

  const snapshot = {
    owner: [...base.owner],
    superAdmins: [...base.superAdmins],
    admins: [...base.admins],
  };

  if (role === 'owner') {
    if (snapshot.owner.length >= LIMITS.owner) return { ok: false, error: `Owner limit reached (${snapshot.owner.length}/${LIMITS.owner})` };
    if (!snapshot.owner.includes(id)) snapshot.owner.push(id);
  } else  if (role === 'superAdmin') {
    if (snapshot.superAdmins.length >= LIMITS.superAdmin) return { ok: false, error: `Super Admin limit reached (${snapshot.superAdmins.length}/${LIMITS.superAdmin})` };
    if (!snapshot.superAdmins.includes(id)) snapshot.superAdmins.push(id);
  } else  if (role === 'admin') {
    if (snapshot.admins.length >= LIMITS.admin) return { ok: false, error: `Admin limit reached (${snapshot.admins.length}/${LIMITS.admin})` };
    if (!snapshot.admins.includes(id)) snapshot.admins.push(id);
  } else {
    return { ok: false, error: `Invalid role: ${role}` };
  }

  pendingRoles = snapshot;
  return { ok: true, staged: snapshot };
}

export function removeUserFromStage(userId) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  const base = pendingRoles || { ...roles, owner: [...roles.owner], superAdmins: [...roles.superAdmins], admins: [...roles.admins] };

  const snapshot = {
    owner: base.owner.filter(x => x !== id),
    superAdmins: base.superAdmins.filter(x => x !== id),
    admins: base.admins.filter(x => x !== id),
  };

  pendingRoles = snapshot;
  return { ok: true, staged: snapshot };
}

function findUserRoleInSnapshot(snapshot, userId) {
  if (snapshot.owner.includes(userId)) return 'owner';
  if (snapshot.superAdmins.includes(userId)) return 'superAdmin';
  if (snapshot.admins.includes(userId)) return 'admin';
  return null;
}
