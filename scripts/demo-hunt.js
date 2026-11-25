// Real-hunter demo: the hunter attacks the 3 held-out targets in targets/ that it has no exploit
// for. Local anvil only; nothing is deployed to any public chain.
//
//   npm run demo:hunt                         offline: Telegraph mock + replay of the model outputs
//                                             recorded by the last live run (no model is called)
//   TELEGRAPH_MODE=live npm run demo:hunt     real Telegraph purchases (Base Sepolia test USDC) and
//                                             a real model: Anthropic API if ANTHROPIC_API_KEY is
//                                             set, else the local Claude Code CLI (headless)
//   LLM_BACKEND=api|cli|replay                override the model backend
//   TARGETS=init-vault,share-vault            hunt a subset
//
// Evidence: evidence/hunt/<run-id>/ (run.json, per-attempt prompts, responses, proofs, verdicts).
import fs from "node:fs";
import path from "node:path";
import { parseEther, formatEther, parseEventLogs } from "viem";
import {
  ROOT,
  startAnvil,
  forgeBuild,
  artifact,
  deploy,
} from "../lib/chain.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";
import { liveSpentAtomic } from "../lib/telegraph.js";
import {
  API_USD_CAP,
  CLI_CALL_CAP,
  CallBudget,
  UsdBudget,
  createApiBackend,
  createCliBackend,
  createReplayBackend,
} from "../lib/llm.js";
import { startMockServer } from "../mock/ask-server.js";
import { loadTarget, listTargetIds, loadGroundTruth } from "../targets/index.js";
import { checkIntents, huntTarget, INTENTS, secondOpinion } from "../agent/real-hunter.js";
import { resolveSubmission } from "../verifier/resolver.js";

const HUNT_DIR = path.join(ROOT, "evidence", "hunt");
const mode = process.env.TELEGRAPH_MODE === "live" ? "live" : "mock";
const log = (m) => console.log(m);

function latestRecordedRun() {
  if (!fs.existsSync(HUNT_DIR)) return null;
  const runs = fs
    .readdirSync(HUNT_DIR)
    .filter(
      (d) =>
        d.startsWith("live-") &&
        fs.existsSync(path.join(HUNT_DIR, d, "run.json")),
    )
    .sort();
  return runs.length ? path.join(HUNT_DIR, runs.at(-1)) : null;
}

function loadRecordings(runDir, ids) {
  const rec = {};
  for (const id of ids) {
    const d = path.join(runDir, id);
    if (!fs.existsSync(d)) continue;
    rec[id] = fs
      .readdirSync(d)
      .filter((f) => /^attempt-\d+\.response\.txt$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((f) => fs.readFileSync(path.join(d, f), "utf8"));
  }
  return rec;
}

async function makeLlm(ids) {
  const choice =
    process.env.LLM_BACKEND ||
    (mode === "live"
      ? process.env.ANTHROPIC_API_KEY
        ? "api"
        : "cli"
      : "replay");
  if (choice === "api")
    return createApiBackend({ budget: new UsdBudget(API_USD_CAP) });
  if (choice === "cli")
    return createCliBackend({ budget: new CallBudget(CLI_CALL_CAP) });
  if (choice === "replay") {
    const dir = process.env.REPLAY_FROM
      ? path.resolve(process.env.REPLAY_FROM)
      : latestRecordedRun();
    const rec = dir ? loadRecordings(dir, ids) : {};
    return createReplayBackend(
      rec,
      dir ? path.relative(ROOT, dir) : "nothing (no recorded live run)",
    );
  }
  throw new Error(`LLM_BACKEND must be api, cli or replay (got ${choice})`);
}

function events(rcpt) {
  return parseEventLogs({ abi: ESCROW_ABI, logs: rcpt.logs }).map((e) => ({
    event: e.eventName,
    args: Object.fromEntries(
      Object.entries(e.args).map(([k, v]) => [
        k,
        typeof v === "bigint" ? v.toString() : v,
      ]),
    ),
  }));
}

async function intentsFor() {
  const snapshot = path.join(HUNT_DIR, "intents-latest.json");
  if (mode === "live") {
    const i = await checkIntents();
    fs.mkdirSync(HUNT_DIR, { recursive: true });
    fs.writeFileSync(
      snapshot,
      JSON.stringify({ at: new Date().toISOString(), intents: i }, null, 2) +
        "\n",
    );
    return { source: "live GET /engine/v1/intents/<NAME>", intents: i };
  }
  if (fs.existsSync(snapshot)) {
    const j = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    return {
      source: `snapshot ${path.relative(ROOT, snapshot)} (${j.at})`,
      intents: j.intents,
    };
  }
  const all = Object.fromEntries(
    Object.values(INTENTS).map((n) => [n, { usable: true, reason: null }]),
  );
  return {
    source: "no snapshot: mock assumes every intent usable",
    intents: all,
  };
}

async function main() {
  const ids = process.env.TARGETS
    ? process.env.TARGETS.split(",")
    : listTargetIds();
  const runId = `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const evidenceDir = path.join(HUNT_DIR, runId);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const llm = await makeLlm(ids);
  const groundTruth = loadGroundTruth();
  const { source: intentsSource, intents } = await intentsFor();
  const spentBefore = liveSpentAtomic();
  log(`== real hunter, run ${runId}`);
  log(
    `   Telegraph: ${mode}; model backend: ${llm.name}${llm.source ? ` (${llm.source})` : ""}`,
  );
  log(`   intents (${intentsSource}):`);
  for (const [n, i] of Object.entries(intents))
    log(
      `     ${n}: ${i.usable ? "use" : "skip"}${i.miner_count != null ? `, ${i.miner_count} miners, ${i.lifecycle}` : ""}${i.reason ? ` (${i.reason})` : ""}`,
    );

  forgeBuild();
  const env = await startAnvil();
  const mock = mode === "mock" ? await startMockServer() : null;
  const [poster, verifier, hunter] = env.accounts;
  const run = {
    run_id: runId,
    at: new Date().toISOString(),
    telegraph_mode: mode,
    llm_backend: llm.name,
    llm_source: llm.source ?? null,
    chain: "local anvil (chainid 31337)",
    intents_source: intentsSource,
    intents,
    targets: [],
  };
  try {
    const escrow = (
      await deploy(env, poster, artifact("BountyEscrow.sol", "BountyEscrow"))
    ).address;
    run.escrow = escrow;
    log(`== BountyEscrow on local anvil at ${escrow}`);
    for (const [i, id] of ids.entries()) {
      const target = await loadTarget(id);
      const block = await env.pub.getBlock();
      const postTx = await env.wallet.writeContract({
        account: poster,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "post",
        args: [
          verifier,
          block.timestamp + 7n * 86400n,
          target.targetHash,
          target.invariantHash,
        ],
        value: parseEther("1"),
      });
      await env.pub.waitForTransactionReceipt({ hash: postTx });
      const bountyId = BigInt(i);
      log(
        `\n== target ${id}: bounty #${bountyId}, 1 ETH, invariant: ${target.invariant}`,
      );
      const handToVerifier = (proofSource, hunterAddr) =>
        resolveSubmission({
          env,
          escrow,
          bountyId,
          verifier,
          proofSource,
          hunter: hunterAddr,
          log: (m) => log(`  ${m}`),
          target,
          verdictDir: path.join(evidenceDir, "verdicts"),
        });
      const r = await huntTarget({
        target,
        telegraph: { mode, endpoint: mock?.url, network: "base" },
        intents,
        llm,
        evidenceDir,
        chain: { env, escrow, bountyId, hunter, handToVerifier },
        log,
      });
      r.post_tx = postTx;
      // Scored after the hunt; the hunter itself never sees the ground truth.
      r.second_opinion = secondOpinion(r, groundTruth[id]);
      if (r.resolution) {
        const rc = await env.pub.getTransactionReceipt({
          hash: r.resolution.resolveTx,
        });
        r.resolve_events = events(rc);
      }
      run.targets.push(r);
    }

    const owed = await env.pub.readContract({
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "owed",
      args: [hunter],
    });
    run.hunter_owed_wei = owed.toString();
    if (owed > 0n) {
      const wtx = await env.wallet.writeContract({
        account: hunter,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "withdraw",
      });
      const wr = await env.pub.waitForTransactionReceipt({ hash: wtx });
      run.withdraw = { tx: wtx, events: events(wr) };
    }
  } finally {
    run.telegraph_live_spend_this_run_usd =
      Number(liveSpentAtomic() - spentBefore) / 1e6;
    run.attempts_total = run.targets.reduce(
      (s, t) => s + (t.attempts?.length ?? 0),
      0,
    );
    // Calls that reached a model (replay backend: 0).
    run.model_calls = llm.budget ? llm.budget.calls : 0;
    run.model_cost_usd = run.targets.reduce(
      (s, t) =>
        s +
        (t.attempts ?? []).reduce((a, x) => a + (Number(x.cost_usd) || 0), 0),
      0,
    );
    run.solved = run.targets.filter((t) => t.resolution?.valid).length;
    run.second_opinion_tally = run.targets.reduce((m, t) => {
      const v = t.second_opinion?.verdict ?? "none";
      m[v] = (m[v] ?? 0) + 1;
      return m;
    }, {});
    fs.writeFileSync(
      path.join(evidenceDir, "run.json"),
      JSON.stringify(run, null, 2) + "\n",
    );
    await mock?.close();
    await env.stop();
  }

  log("\n== summary");
  for (const t of run.targets) {
    log(`\n${t.target_id}:`);
    for (const p of t.purchases)
      log(
        `  bought ${p.role.padEnd(12)} ${p.intent} -> ${p.miner_name ?? p.miner_id ?? "-"} status ${p.status}${p.miner_answered ? "" : " (no miner answer)"} $${p.cost_usd ?? "?"} ${p.settle_tx ?? ""}`,
      );
    for (const s of t.skipped_intents)
      log(`  skipped      ${s.intent}: ${s.reason}`);
    for (const a of t.attempts)
      log(
        `  attempt ${a.attempt} ${a.model} -> ${a.valid ? "VALID" : "invalid"} [${a.stage ?? "error"}] ${(a.reason ?? a.error ?? "").slice(0, 110)}${a.cost_usd != null ? ` ($${Number(a.cost_usd).toFixed(4)})` : ""}`,
      );
    const paid = t.resolve_events?.find((e) => e.event === "Paid");
    log(
      `  result: ${t.resolution ? (t.resolution.valid ? "VALID" : "INVALID") : "no self-checked proof, nothing committed"}` +
        (paid
          ? `, paid ${formatEther(BigInt(paid.args.reward))} ETH (resolve tx ${t.resolution.resolveTx})`
          : ""),
    );
    if (t.second_opinion) log(`  second opinion vs ground truth: ${t.second_opinion.line}`);
  }
  log(
    `\nsolved ${run.solved}/${run.targets.length}; model calls ${run.model_calls}` +
      ` (backend ${run.llm_backend}, reported cost $${run.model_cost_usd.toFixed(4)});` +
      ` Telegraph live spend this run $${run.telegraph_live_spend_this_run_usd.toFixed(2)}` +
      `; hunter withdrew ${formatEther(BigInt(run.hunter_owed_wei ?? 0))} ETH`,
  );
  log(
    `second opinions: ${Object.entries(run.second_opinion_tally).map(([k, v]) => `${k} ${v}`).join(", ")}` +
      " (payout was decided by the deterministic verifier in every case)",
  );
  log(`evidence: ${path.relative(ROOT, evidenceDir)}/`);
}

main().catch((e) => {
  console.error(`demo:hunt failed: ${e.stack || e.message}`);
  process.exit(1);
});
