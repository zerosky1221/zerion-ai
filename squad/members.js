/**
 * Member roster + role management.
 *
 * A member row is the source of truth for "who can vote". Quorum math in
 * `proposals.js` reads countActiveMembers() on every proposal, so removing a
 * member instantly tightens the consensus requirement.
 */

import { getDb } from "./db.js";

export function addMember({ telegramId, username, role = "voter" }) {
  const stmt = getDb().prepare(
    "INSERT INTO members(telegram_id, username, role, added_at) VALUES(?, ?, ?, ?) " +
    "ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username"
  );
  stmt.run(telegramId, username || null, role, new Date().toISOString());
}

export function setRole(telegramId, role) {
  getDb().prepare("UPDATE members SET role = ? WHERE telegram_id = ?").run(role, telegramId);
}

export function removeMember(telegramId) {
  getDb().prepare("DELETE FROM members WHERE telegram_id = ?").run(telegramId);
}

export function getMember(telegramId) {
  return getDb().prepare("SELECT * FROM members WHERE telegram_id = ?").get(telegramId);
}

export function listMembers() {
  return getDb().prepare("SELECT * FROM members ORDER BY added_at ASC").all();
}

export function countActiveMembers() {
  return getDb().prepare("SELECT COUNT(*) as n FROM members").get().n;
}

export function isAdmin(telegramId) {
  const m = getMember(telegramId);
  return m?.role === "admin";
}

export function ensureAtLeastOneAdmin(telegramId, username) {
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) as n FROM members WHERE role = 'admin'").get().n;
  if (n === 0) {
    addMember({ telegramId, username, role: "admin" });
    return true;
  }
  return false;
}
