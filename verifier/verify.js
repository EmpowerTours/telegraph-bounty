// Deterministic proof verifier. No model opinion anywhere in this file.
//
// A proof is one self-contained Solidity file defining
//   contract Exploit { constructor(address vault) payable; function run() external; }
// The verifier:
//   1. static checks (size, no imports, contract present)
//   2. compiles it alone with forge in a throwaway sandbox (proof cannot reach repo sources)
//   3. for each target (VulnerableVault, PatchedVault) starts a FRESH anvil chain at a fixed
//      genesis timestamp, deploys the target, seeds 3 honest deposits (3 + 3 + 4 ether),
//      deploys Exploit with 1 ether from a separate attacker account and calls run() once
//      (gas pinned to 5,000,000; a revert is allowed and recorded)
//   4. evaluates the stated invariant: address(vault).balance >= vault.totalDeposits()
// VALID iff the invariant is broken on the vulnerable target AND holds on the patched target.
// Running on anvil (not inside `forge test`) means the proof cannot call Foundry cheatcodes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { keccak256, toBytes, parseEther, getAddress } from "viem";
import {
  ROOT,
  FORGE,
  startAnvil,
  forgeBuild,
  artifact,
  deploy,
  send,
  targetHash,
  INVARIANT,
  invariantHash,
} from "../lib/chain.js";

export const MAX_PROOF_BYTES = 32 * 1024;
const SEED = [parseEther("3"), parseEther("3"), parseEther("4")];
const ATTACK_VALUE = parseEther("1");
export const RUN_GAS = 5_000_000n;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value === "bigint" ? value.toString() : value);
}

export function proofHashOf(source) {
  return keccak256(toBytes(source));
}

export function staticCheck(source) {
  if (Buffer.byteLength(source) > MAX_PROOF_BYTES)
    return `proof larger than ${MAX_PROOF_BYTES} bytes`;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (/^\s*import\b/m.test(code))
    return "imports are not allowed; the proof must be self-contained";
  if (!/\bcontract\s+Exploit\b/.test(code))
    return "no `contract Exploit` found";
  return null;
}

/** @param {{errorLines?: number}} [opts] how many trailing forge output lines go into the error */
export function compileProof(source, { errorLines = 6 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounty-proof-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "Submitted.sol"), source);
    fs.copyFileSync(
      path.join(ROOT, "foundry.toml"),
      path.join(dir, "foundry.toml"),
    );
    try {
      execFileSync(FORGE, ["build", "--root", dir, "--offline"], {
        stdio: "pipe",
        timeout: 180_000,
      });
    } catch (e) {
      const msg = String(e.stderr || e.stdout || e.message)
        .split("\n")
        .filter(Boolean)
        .slice(-errorLines)
        .join(" | ");
      return { error: `compile failed: ${msg}` };
    }
    const art = artifact("Submitted.sol", "Exploit", path.join(dir, "out"));
    const ctor = art.abi.find((x) => x.type === "constructor");
    const run = art.abi.find((x) => x.type === "function" && x.name === "run");
    if (
      !ctor ||
      ctor.inputs.length !== 1 ||
      ctor.inputs[0].type !== "address" ||
      ctor.stateMutability !== "payable"
    ) {
      return {
        error: "Exploit must have `constructor(address vault) payable`",
      };
    }
    if (!run || run.inputs.length !== 0)
      return { error: "Exploit must have `function run() external`" };
    return { art };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runScenario(targetArt, exploitArt) {
  const env = await startAnvil();
  try {
    const [deployer, u1, u2, u3, , , , , , attacker] = env.accounts;
    const vault = await deploy(env, deployer, targetArt);
    for (const [i, user] of [u1, u2, u3].entries()) {
      const r = await send(
        env,
        user,
        vault.address,
        targetArt.abi,
        "deposit",
        [],
        { value: SEED[i] },
      );
      if (r.status !== "success") throw new Error("seed deposit failed");
    }
    // Pinned gas (no estimation), so a reverting or gas-burning constructor is recorded, not thrown.
    const deployHash = await env.wallet.deployContract({
      account: attacker,
      abi: exploitArt.abi,
      bytecode: exploitArt.bytecode,
      args: [vault.address],
      value: ATTACK_VALUE,
      gas: RUN_GAS,
    });
    const dr = await env.pub.waitForTransactionReceipt({ hash: deployHash });
    let r = null;
    if (dr.status === "success") {
      r = await send(
        env,
        attacker,
        dr.contractAddress,
        exploitArt.abi,
        "run",
        [],
        {
          gas: RUN_GAS,
        },
      );
    }
    const balance = await env.pub.getBalance({ address: vault.address });
    const totalDeposits = await env.pub.readContract({
      address: vault.address,
      abi: targetArt.abi,
      functionName: "totalDeposits",
    });
    const exploitBalance =
      dr.status === "success"
        ? await env.pub.getBalance({ address: dr.contractAddress })
        : 0n;
    return {
      vault: getAddress(vault.address),
      deploy_status: dr.status,
      run_status: r ? r.status : "not_run",
      run_gas_used: r ? r.gasUsed.toString() : "0",
      vault_balance_wei: balance.toString(),
      total_deposits_wei: totalDeposits.toString(),
      exploit_balance_wei: exploitBalance.toString(),
      invariant_holds: balance >= totalDeposits,
    };
  } finally {
    await env.stop();
  }
}

/**
 * @param {string} source proof source text
 * @returns {Promise<{verdict: object, verdictHash: string}>}
 */
export async function verifyProof(source) {
  const base = {
    schema: "telegraph-bounty/verdict@1",
    proof_hash: proofHashOf(source),
    target_hash: targetHash(),
    invariant: INVARIANT,
    invariant_hash: invariantHash(),
    scenario: {
      seed_deposits_wei: SEED.map(String),
      attack_value_wei: ATTACK_VALUE.toString(),
      run_gas: RUN_GAS.toString(),
      genesis_timestamp: 1_767_225_600,
    },
  };
  const finish = (fields) => {
    const verdict = { ...base, ...fields };
    return { verdict, verdictHash: keccak256(toBytes(canonical(verdict))) };
  };

  const staticError = staticCheck(source);
  if (staticError)
    return finish({
      valid: false,
      stage: "static",
      reason: staticError,
      results: null,
    });

  const compiled = compileProof(source);
  if (compiled.error)
    return finish({
      valid: false,
      stage: "compile",
      reason: compiled.error,
      results: null,
    });

  if (!fs.existsSync(path.join(ROOT, "out", "VulnerableVault.sol")))
    forgeBuild();
  const vulnerable = await runScenario(
    artifact("VulnerableVault.sol", "VulnerableVault"),
    compiled.art,
  );
  const patched = await runScenario(
    artifact("PatchedVault.sol", "PatchedVault"),
    compiled.art,
  );
  const results = { vulnerable, patched };

  if (vulnerable.invariant_holds) {
    return finish({
      valid: false,
      stage: "execute",
      reason: "invariant still holds on the vulnerable target",
      results,
    });
  }
  if (!patched.invariant_holds) {
    return finish({
      valid: false,
      stage: "execute",
      reason:
        "invariant also breaks on the patched target; the proof does not isolate the fixed bug",
      results,
    });
  }
  return finish({
    valid: true,
    stage: "execute",
    reason: "breaks invariant on vulnerable, holds on patched",
    results,
  });
}
