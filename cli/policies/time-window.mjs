#!/usr/bin/env node
/**
 * Executable policy: only permit execution during an approved UTC hour window.
 *
 * policy_config.time_window_utc = { start_hour: 0..23, end_hour: 0..23 }
 *   - inclusive of start, exclusive of end
 *   - wrap-around supported (e.g. 22→06 = late night)
 *   - null value disables the check
 *
 * Rationale: guard against someone with the agent token firing trades at
 * 3am when the group isn't watching. Combined with quorum-required, this
 * forces deliberate business-hours execution.
 */

import { fileURLToPath } from "node:url";
import { runPolicyFromStdin } from "../lib/util/prompt.js";
import { getReadOnlyDb, readonlyPolicyConfig } from "../../squad/db.js";

export function check(ctx) {
  let db;
  try {
    db = getReadOnlyDb();
  } catch (err) {
    // In squad mode (ZERION_PROPOSAL_ID set), the DB is mandatory for the
    // window check — fail closed so deleting the sqlite file can't silently
    // disable the time gate. In solo/base-CLI mode (no proposal id in env),
    // allow so the CLI still works without a squad sqlite.
    if (process.env.ZERION_PROPOSAL_ID) {
      return {
        allow: false,
        reason: `Squad DB unreachable (${err.message}) — time window cannot be verified.`,
      };
    }
    return { allow: true };
  }

  try {
    const cfg = readonlyPolicyConfig(db);
    const window = cfg.time_window_utc;
    if (!window || window.start_hour === undefined || window.end_hour === undefined) {
      return { allow: true };
    }

    const hour = new Date().getUTCHours();
    const { start_hour: s, end_hour: e } = window;
    const inside = s < e ? hour >= s && hour < e : hour >= s || hour < e;
    if (!inside) {
      return {
        allow: false,
        reason: `Outside allowed UTC window ${s}:00–${e}:00 (now ${hour}:00 UTC).`,
      };
    }
    return { allow: true };
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPolicyFromStdin(check);
}
