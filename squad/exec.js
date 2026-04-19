/**
 * Wrapper that spawns the `zerion` CLI with the proposal-id env var set.
 *
 * This is the only path by which the bot turns an approved proposal into an
 * onchain transaction. ZERION_PROPOSAL_ID plumbs through to the custom
 * policies which refuse to sign unless the DB agrees.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { loadConfig } from "./config.js";
import {
  markExecuting,
  markExecuted,
  markFailed,
  getProposal,
} from "./proposals.js";

const LOCAL_CLI = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cli",
  "zerion.js"
);

function resolveCliCommand(cliCommand) {
  if (!cliCommand || cliCommand === "zerion") {
    return { cmd: process.execPath, prefixArgs: [LOCAL_CLI] };
  }
  return { cmd: cliCommand, prefixArgs: [] };
}

function argvForProposal(proposal) {
  const p = proposal.params;
  switch (proposal.type) {
    case "swap": {
      const out = ["swap", p.fromToken, p.toToken, String(p.amount)];
      if (p.chain) out.push("--chain", p.chain);
      if (p.toChain && p.toChain !== p.chain) out.push("--to-chain", p.toChain);
      if (p.slippage) out.push("--slippage", String(p.slippage));
      return out;
    }
    case "bridge": {
      const out = ["bridge", p.token, p.toChain, String(p.amount), "--from-chain", p.fromChain];
      if (p.toToken) out.push("--to-token", p.toToken);
      return out;
    }
    case "send": {
      return ["send", p.token, String(p.amount), "--to", p.to, "--chain", p.chain];
    }
    default:
      throw new Error(`Unsupported proposal type: ${proposal.type}`);
  }
}

function extractTxHash(stdout) {
  try {
    const json = JSON.parse(stdout.trim());
    return json?.tx?.hash || null;
  } catch {
    const m = stdout.match(/0x[a-fA-F0-9]{64}/);
    return m ? m[0] : null;
  }
}

// Filter deprecation warnings and the "(Use `node --trace-deprecation ...`)"
// follow-up lines so they never leak into bot output or logs.
function stripNodeNoise(s) {
  return s
    .replace(/^\s*\(node:\d+\)[^\n]*\n?/gm, "")
    .replace(/^\s*\(Use `node --trace-[^\n]*\n?/gm, "");
}

export async function executeProposal(proposalId, { onLog } = {}) {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.status !== "approved") {
    throw new Error(`Proposal ${proposalId} is ${proposal.status}, not approved`);
  }

  const cfg = loadConfig();
  // Atomic approved → executing + reservation insert. Throws if another
  // caller already transitioned the proposal (double-execution guard).
  try {
    markExecuting(proposalId);
  } catch (err) {
    return { status: "failed", reason: err.message, stdout: "", stderr: "" };
  }

  const args = argvForProposal(proposal);
  const env = {
    ...process.env,
    ZERION_PROPOSAL_ID: proposalId,
    SQUAD_DB_PATH: cfg.dbPath,
    NODE_NO_WARNINGS: "1",
  };
  if (cfg.zerion.apiKey) env.ZERION_API_KEY = cfg.zerion.apiKey;
  if (cfg.zerion.agentToken) env.ZERION_AGENT_TOKEN = cfg.zerion.agentToken;

  return new Promise((resolve) => {
    if (cfg.dryRun) {
      onLog?.(`[dry-run] zerion ${args.join(" ")}\n`);
      markExecuted(proposalId, {
        txHash: "0xdry-run",
        amountUsd: Number(proposal.estimated_usd || 0),
      });
      resolve({ status: "dry-run", txHash: "0xdry-run", stdout: "", stderr: "" });
      return;
    }

    const { cmd, prefixArgs } = resolveCliCommand(cfg.cliCommand);
    // Never use `shell: true` — args are user-controlled proposal params and
    // would be interpreted by cmd.exe/sh, enabling RCE via metachars. The
    // strict regex validators in createProposal are a second layer; `spawn`
    // with an array + no shell is the first.
    const child = spawn(cmd, [...prefixArgs, ...args], {
      env,
      windowsVerbatimArguments: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      const chunk = stripNodeNoise(d.toString());
      stdout += chunk;
      if (chunk) onLog?.(chunk);
    });
    child.stderr.on("data", (d) => {
      const chunk = stripNodeNoise(d.toString());
      stderr += chunk;
      if (chunk) onLog?.(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) {
        const txHash = extractTxHash(stdout);
        markExecuted(proposalId, {
          txHash: txHash || "unknown",
          amountUsd: Number(proposal.estimated_usd || 0),
        });
        resolve({ status: "executed", txHash, stdout, stderr, code });
      } else {
        const reason = (stderr.trim() || stdout.trim()).slice(-400) || `exit ${code}`;
        markFailed(proposalId, reason);
        resolve({ status: "failed", reason, stdout, stderr, code });
      }
    });
    child.on("error", (err) => {
      markFailed(proposalId, err.message);
      resolve({ status: "failed", reason: err.message, stdout, stderr });
    });
  });
}
