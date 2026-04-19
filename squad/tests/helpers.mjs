import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withTempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "squad-test-"));
  process.env.SQUAD_DATA_DIR = dir;
  process.env.SQUAD_CONFIG = join(dir, "missing.json"); // force env-driven config
  delete process.env.SQUAD_DB_PATH;

  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  return dir;
}

/**
 * Module cache busts: every test wants a fresh in-memory singleton for db.js
 * (otherwise the cached handle points at the previous tmpdir). Import with a
 * version query so ESM treats each invocation as a new module.
 */
let v = 0;
export async function freshImports() {
  v++;
  return {
    db: await import(`../db.js?v=${v}`),
    members: await import(`../members.js?v=${v}`),
    proposals: await import(`../proposals.js?v=${v}`),
    ledger: await import(`../ledger.js?v=${v}`),
    config: await import(`../config.js?v=${v}`),
    quorum: await import(`../../cli/policies/quorum-required.mjs?v=${v}`),
    spend: await import(`../../cli/policies/daily-spend-limit.mjs?v=${v}`),
    tokens: await import(`../../cli/policies/token-allowlist.mjs?v=${v}`),
    window: await import(`../../cli/policies/time-window.mjs?v=${v}`),
  };
}
