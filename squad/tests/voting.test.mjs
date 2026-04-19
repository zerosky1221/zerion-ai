import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { withTempDb, freshImports } from "./helpers.mjs";

describe("voting lifecycle", () => {
  let mods;

  before(async () => {
    withTempDb({ after });
    mods = await freshImports();
    mods.members.addMember({ telegramId: 1, username: "alice", role: "admin" });
    mods.members.addMember({ telegramId: 2, username: "bob", role: "voter" });
    mods.members.addMember({ telegramId: 3, username: "carol", role: "voter" });
  });

  it("creates a pending proposal", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "10", chain: "base" },
      estimatedUsd: 10,
    });
    assert.equal(p.status, "pending");
    assert.match(p.id, /^prop-[a-f0-9]+$/);
  });

  it("flips to approved once quorum yes-votes accumulate", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "10", chain: "base" },
      estimatedUsd: 10,
    });
    let state = mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "yes" });
    assert.equal(state.status, "pending"); // quorum default is 2
    state = mods.proposals.recordVote({ proposalId: p.id, memberId: 2, vote: "yes" });
    assert.equal(state.status, "approved");
  });

  it("rejects when remaining voters cannot reach quorum", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "10", chain: "base" },
      estimatedUsd: 10,
    });
    // 3 members, quorum=2 → two no-votes mean only 1 yes left = cannot pass
    let s = mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "no" });
    assert.equal(s.status, "pending");
    s = mods.proposals.recordVote({ proposalId: p.id, memberId: 2, vote: "no" });
    assert.equal(s.status, "rejected");
  });

  it("rejects vote on non-existent proposal", () => {
    assert.throws(() =>
      mods.proposals.recordVote({ proposalId: "prop-ffffffff", memberId: 1, vote: "yes" })
    );
  });

  it("re-voting overwrites the previous vote", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "10", chain: "base" },
      estimatedUsd: 10,
    });
    mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "yes" });
    // change mind
    mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "no" });
    const tally = mods.proposals.tally(p.id);
    assert.equal(tally.yes, 0);
    assert.equal(tally.no, 1);
  });

  it("marks executed and appends to ledger", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "10", chain: "base" },
      estimatedUsd: 25.5,
    });
    mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "yes" });
    mods.proposals.recordVote({ proposalId: p.id, memberId: 2, vote: "yes" });
    mods.proposals.markExecuting(p.id);
    mods.proposals.markExecuted(p.id, { txHash: "0xdeadbeef", amountUsd: 25.5 });
    const reloaded = mods.proposals.getProposal(p.id);
    assert.equal(reloaded.status, "executed");
    assert.equal(reloaded.tx_hash, "0xdeadbeef");
    assert.equal(mods.ledger.spentInWindow(), 25.5);
  });
});
