#!/usr/bin/env node
/**
 * Squad Treasury — end-to-end dry-run demo.
 *
 * Reproduces the full flow (roster → proposal → quorum → exec → ledger)
 * without hitting a real chain so judges can verify the policy pipeline.
 *
 * Flip SQUAD_DRY_RUN=false to actually broadcast the swap through the
 * Zerion API — assuming the wallet is funded and agent token is valid.
 *
 *   npm run demo:squad
 *     or
 *   node squad/demo.mjs
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "squad-demo-"));
process.env.SQUAD_DATA_DIR = dir;
process.env.SQUAD_CONFIG = join(dir, "missing.json"); // force env-driven
process.env.SQUAD_DRY_RUN = process.env.SQUAD_DRY_RUN ?? "true";

console.log(`>>> data dir:  ${dir}`);
console.log(`>>> dry-run:   ${process.env.SQUAD_DRY_RUN}`);

const { addMember } = await import("./members.js");
const { createProposal, recordVote } = await import("./proposals.js");
const { executeProposal } = await import("./exec.js");
const { spentInWindow, recentLedgerEntries } = await import("./ledger.js");
const { setPolicyValue } = await import("./db.js");

addMember({ telegramId: 1, username: "alice", role: "admin" });
addMember({ telegramId: 2, username: "bob", role: "voter" });
addMember({ telegramId: 3, username: "carol", role: "voter" });

setPolicyValue("daily_limit_usd", 100);
setPolicyValue("allowed_tokens", ["USDC", "ETH"]);
setPolicyValue("allowed_chains", ["base"]);

const proposal = createProposal({
  proposerId: 1,
  type: "swap",
  params: { fromToken: "USDC", toToken: "ETH", amount: "5", chain: "base" },
  estimatedUsd: 5,
});
console.log(`\n[1] proposal ${proposal.id} created (pending)`);

let state = recordVote({ proposalId: proposal.id, memberId: 1, vote: "yes" });
console.log(`[2] alice votes yes → ${state.status} (${state.votes.yes}/${state.votes.no})`);

state = recordVote({ proposalId: proposal.id, memberId: 2, vote: "yes" });
console.log(`[3] bob votes yes   → ${state.status} (${state.votes.yes}/${state.votes.no})`);

console.log("\n[4] executing proposal (policies run in-process):");
const result = await executeProposal(proposal.id, {
  onLog: (chunk) => process.stdout.write("    cli> " + chunk),
});
console.log(`\n    result: ${result.status} ${result.txHash || result.reason || ""}`);

console.log(`\n[5] rolling 24h spend: $${spentInWindow().toFixed(2)}`);
console.log("    ledger:", recentLedgerEntries());

console.log("\n✓ demo complete — delete", dir, "to clean up.");
