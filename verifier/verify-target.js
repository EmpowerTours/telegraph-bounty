// Deterministic proof verifier for the held-out targets in targets/<id>/. No model opinion here.
//
// Same proof shape and same rule as verifier/verify.js (the reentrancy demo):
//   one self-contained Solidity file, no imports, defining
//   contract Exploit { constructor(address target) payable; function run() external; }
// VALID iff the target's stated invariant is broken on the vulnerable contract AND holds on
// the patched contract.
//
// Per target, the scenario (deploy, honest setup, the attack, honest follow-up actions and the
// invariant check) is code in targets/<id>/target.js. That file is part of the target hash, so a
// bounty commits to the exact scenario as well as to both sources.
//
// For each side (vulnerable, patched) the verifier:
//   1. compiles the target file alone in a throwaway forge sandbox (cached per source hash)
//   2. starts a FRESH anvil chain at a fixed genesis timestamp
//   3. deploys the target from the deployer account and runs target.setup()
//   4. deploys Exploit from a separate attacker account with target.attackValueWei and calls
//      run() once (gas pinned to 5,000,000; reverts are recorded, not thrown)
//   5. runs target.after() (honest actions after the attack) and target.check() (the invariant)
// The proof runs on anvil, not inside `forge test`, so it cannot reach Foundry cheatcodes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { keccak256, toBytes, getAddress } from "viem";
import { FORGE, ROOT, GENESIS_TIMESTAMP, startAnvil } from "../lib/chain.js";
import {
  RUN_GAS,
  canonical,
  compileProof,
  proofHashOf,
  staticCheck,
} from "./verify.js";

const compiled = new Map(); // keccak(source) -> { contracts }

/** Compile one self-contained Solidity file in a sandbox; returns every contract in it. */
export function compileTargetFile(source, fileName) {
  const key = keccak256(toBytes(source));
  if (compiled.has(key)) return compiled.get(key);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounty-target-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", fileName), source);
    fs.copyFileSync(
      path.join(ROOT, "foundry.toml"),
      path.join(dir, "foundry.toml"),
    );
    execFileSync(FORGE, ["build", "--root", dir, "--offline"], {
      stdio: "pipe",
      timeout: 180_000,
      env: { ...process.env, FOUNDRY_PROFILE: "default" },
    });
    const outDir = path.join(dir, "out", fileName);
    const contracts = {};
    for (const f of fs.readdirSync(outDir)) {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
      contracts[f.replace(/\.json$/, "")] = {
        abi: j.abi,
        bytecode: j.bytecode.object,
      };
    }
    const result = { contracts };
    compiled.set(key, result);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeCtx(env, artifacts, target) {
  const [deployer, u1, u2, u3, , , , , , attacker] = env.accounts;
  const send = async (from, to, abi, fn, args = [], { value = 0n } = {}) => {
    const hash = await env.wallet.writeContract({
      account: from,
      address: to,
      abi,
      functionName: fn,
      args,
      value,
      gas: RUN_GAS,
    });
    return env.pub.waitForTransactionReceipt({ hash });
  };
  return {
    env,
    artifacts,
    accounts: { deployer, users: [u1, u2, u3], attacker },
    attackValueWei: target.attackValueWei,
    send,
    /** Like send, but a revert is a scenario bug (setup must not fail). */
    mustSend: async (...a) => {
      const r = await send(...a);
      if (r.status !== "success")
        throw new Error(`scenario step ${a[3]} reverted`);
      return r;
    },
    read: (to, abi, fn, args = []) =>
      env.pub.readContract({ address: to, abi, functionName: fn, args }),
    balance: (address) => env.pub.getBalance({ address }),
  };
}

async function runSide(target, side, exploitArt) {
  const spec = target[side];
  const { contracts } = compileTargetFile(
    side === "vulnerable" ? target.vulnerableSource : target.patchedSource,
    spec.file,
  );
  const art = contracts[spec.contract];
  if (!art) throw new Error(`${spec.file} has no contract ${spec.contract}`);
  const env = await startAnvil();
  try {
    const ctx = makeCtx(env, contracts, target);
    const dh = await env.wallet.deployContract({
      account: ctx.accounts.deployer,
      abi: art.abi,
      bytecode: art.bytecode,
      args: [],
    });
    const drc = await env.pub.waitForTransactionReceipt({ hash: dh });
    if (drc.status !== "success") throw new Error("target deploy reverted");
    ctx.target = { address: drc.contractAddress, abi: art.abi };
    await target.setup(ctx);

    const deployHash = await env.wallet.deployContract({
      account: ctx.accounts.attacker,
      abi: exploitArt.abi,
      bytecode: exploitArt.bytecode,
      args: [ctx.target.address],
      value: target.attackValueWei,
      gas: RUN_GAS,
    });
    const dr = await env.pub.waitForTransactionReceipt({ hash: deployHash });
    let r = null;
    if (dr.status === "success")
      r = await ctx.send(
        ctx.accounts.attacker,
        dr.contractAddress,
        exploitArt.abi,
        "run",
      );
    ctx.exploit = dr.status === "success" ? dr.contractAddress : null;

    const afterSteps = (await target.after?.(ctx)) ?? null;
    const check = await target.check(ctx);
    return {
      target: getAddress(ctx.target.address),
      deploy_status: dr.status,
      run_status: r ? r.status : "not_run",
      run_gas_used: r ? r.gasUsed.toString() : "0",
      after: afterSteps,
      observed: check.observed,
      invariant_holds: check.holds,
    };
  } finally {
    await env.stop();
  }
}

/**
 * Verify a proof against a loaded target (see targets/index.js loadTarget()).
 * @param {string} source proof source
 * @param {object} target loaded target
 * @param {{errorLines?: number}} [opts] errorLines: forge output lines kept on a compile error
 */
export async function verifyTargetProof(
  source,
  target,
  { errorLines = 40 } = {},
) {
  const base = {
    schema: "telegraph-bounty/verdict@2",
    target_id: target.id,
    proof_hash: proofHashOf(source),
    target_hash: target.targetHash,
    invariant: target.invariant,
    invariant_hash: target.invariantHash,
    scenario: {
      attack_value_wei: target.attackValueWei.toString(),
      run_gas: RUN_GAS.toString(),
      genesis_timestamp: GENESIS_TIMESTAMP,
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
  const c = compileProof(source, { errorLines });
  if (c.error)
    return finish({
      valid: false,
      stage: "compile",
      reason: c.error,
      results: null,
    });

  const vulnerable = await runSide(target, "vulnerable", c.art);
  const patched = await runSide(target, "patched", c.art);
  const results = { vulnerable, patched };
  if (vulnerable.invariant_holds)
    return finish({
      valid: false,
      stage: "execute",
      reason: "invariant still holds on the vulnerable target",
      results,
    });
  if (!patched.invariant_holds)
    return finish({
      valid: false,
      stage: "execute",
      reason:
        "invariant also breaks on the patched target; the proof does not isolate the fixed bug",
      results,
    });
  return finish({
    valid: true,
    stage: "execute",
    reason: "breaks invariant on vulnerable, holds on patched",
    results,
  });
}
