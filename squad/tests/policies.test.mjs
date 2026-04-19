import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { withTempDb, freshImports } from "./helpers.mjs";

describe("policies — squad guard chain", () => {
  let mods;

  before(async () => {
    withTempDb({ after });
    mods = await freshImports();
    mods.members.addMember({ telegramId: 1, username: "alice", role: "admin" });
    mods.members.addMember({ telegramId: 2, username: "bob", role: "voter" });
  });

  const proposeAndApprove = ({ params, estimatedUsd = 100 } = {}) => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: params || { fromToken: "USDC", toToken: "ETH", amount: "100", chain: "base" },
      estimatedUsd,
    });
    mods.proposals.recordVote({ proposalId: p.id, memberId: 1, vote: "yes" });
    mods.proposals.recordVote({ proposalId: p.id, memberId: 2, vote: "yes" });
    return p;
  };

  it("quorum-required refuses when env has no proposal id", () => {
    delete process.env.ZERION_PROPOSAL_ID;
    const r = mods.quorum.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /ZERION_PROPOSAL_ID/);
  });

  it("quorum-required refuses non-existent proposal", () => {
    process.env.ZERION_PROPOSAL_ID = "prop-ffffffff";
    const r = mods.quorum.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /not found/);
  });

  it("quorum-required refuses a pending proposal", () => {
    const p = mods.proposals.createProposal({
      proposerId: 1,
      type: "swap",
      params: { fromToken: "USDC", toToken: "ETH", amount: "100", chain: "base" },
      estimatedUsd: 100,
    });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.quorum.check({});
    assert.equal(r.allow, false);
  });

  it("quorum-required allows an approved proposal", () => {
    const p = proposeAndApprove();
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.quorum.check({});
    assert.equal(r.allow, true);
  });

  it("daily-spend-limit blocks when projected total exceeds cap", () => {
    mods.db.setPolicyValue("daily_limit_usd", 150);
    const p = proposeAndApprove({ estimatedUsd: 160 });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.spend.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /Daily spend cap breached/);
  });

  it("daily-spend-limit allows when below cap", () => {
    mods.db.setPolicyValue("daily_limit_usd", 1000);
    const p = proposeAndApprove({ estimatedUsd: 50 });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.spend.check({});
    assert.equal(r.allow, true);
  });

  it("daily-spend-limit is bypassed when cap is null", () => {
    mods.db.setPolicyValue("daily_limit_usd", null);
    const p = proposeAndApprove({ estimatedUsd: 999999 });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.spend.check({});
    assert.equal(r.allow, true);
  });

  it("token-allowlist blocks when proposal touches a disallowed token", () => {
    mods.db.setPolicyValue("allowed_tokens", ["USDC", "ETH"]);
    mods.db.setPolicyValue("allowed_chains", ["base"]);
    const p = proposeAndApprove({
      params: { fromToken: "SHIB", toToken: "ETH", amount: "1", chain: "base" },
    });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.tokens.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /SHIB/);
  });

  it("token-allowlist blocks a disallowed chain", () => {
    mods.db.setPolicyValue("allowed_chains", ["base"]);
    mods.db.setPolicyValue("allowed_tokens", null);
    const p = proposeAndApprove({
      params: { fromToken: "USDC", toToken: "ETH", amount: "1", chain: "arbitrum" },
    });
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.tokens.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /arbitrum/);
  });

  it("token-allowlist allows within the allowlist", () => {
    mods.db.setPolicyValue("allowed_tokens", ["USDC", "ETH"]);
    mods.db.setPolicyValue("allowed_chains", ["base"]);
    const p = proposeAndApprove();
    process.env.ZERION_PROPOSAL_ID = p.id;
    const r = mods.tokens.check({});
    assert.equal(r.allow, true);
  });

  it("time-window blocks outside the configured range", () => {
    const hour = new Date().getUTCHours();
    // create a 1-hour window that excludes the current hour
    const start = (hour + 2) % 24;
    const end = (hour + 3) % 24;
    mods.db.setPolicyValue("time_window_utc", { start_hour: start, end_hour: end });
    const r = mods.window.check({});
    assert.equal(r.allow, false);
    assert.match(r.reason, /Outside allowed UTC window/);
  });

  it("time-window allows when current hour is inside range", () => {
    const hour = new Date().getUTCHours();
    const start = hour;
    const end = (hour + 1) % 24;
    mods.db.setPolicyValue("time_window_utc", { start_hour: start, end_hour: end });
    const r = mods.window.check({});
    assert.equal(r.allow, true);
  });

  it("time-window disabled by null config", () => {
    mods.db.setPolicyValue("time_window_utc", null);
    const r = mods.window.check({});
    assert.equal(r.allow, true);
  });
});
