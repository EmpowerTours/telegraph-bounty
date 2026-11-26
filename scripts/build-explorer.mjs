#!/usr/bin/env node
// Builds docs/index.html, a static read-only explorer of the recorded hunts.
//
//   npm run explorer
//
// Reads evidence/hunt/<run-id>/run.json for every 5-target live run and the latest
// offline (mock) run, keeps only what the page shows, and inlines it into
// scripts/explorer/template.html with scripts/explorer/app.js. No network, no keys.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUNT = path.join(ROOT, "evidence", "hunt");
const OUT = path.join(ROOT, "docs", "index.html");

// Hand-written context for runs whose numbers alone would mislead.
const NOTES = {
  "live-2026-11-24T03-54-24-021Z":
    "First 5-target live run. The review miner was Salence; the patch check was routed to Judge0, a sandbox that cannot compile Solidity, so it always answered “failure”.",
  "live-2026-11-25T23-04-33-007Z":
    "Telegraph’s payment facilitator was failing during this run (402 batch_send_failed: stale_pending_nonce), so no purchase settled and no review reached the model. The hunter solved all five anyway; hook-vault needed a second attempt after a format error.",
  "live-2026-11-26T15-37-34-563Z":
    "Every purchase settled on Base Sepolia. The review miner (VulnRank) answered “Secure, 0 issues” for all five contracts; the verifier proved a bug in each.",
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);

function invariantOf(runDir, targetId) {
  const prompt = path.join(runDir, targetId, "attempt-1.prompt.txt");
  if (!exists(prompt)) return "";
  const m = fs
    .readFileSync(prompt, "utf8")
    .match(/invariant[^\n]*:\s*([^\n]+)/i);
  return m ? m[1].trim() : "";
}

function attemptsOf(runDir, t) {
  return t.attempts.map((a, i) => {
    const f = path.join(runDir, t.target_id, `attempt-${i + 1}.json`);
    const rec = exists(f) ? readJson(f) : {};
    return {
      n: i + 1,
      model: a.model ?? rec.model ?? null,
      cost: a.cost_usd ?? rec.cost_usd ?? 0,
      valid: rec.valid ?? null,
      reason: rec.reason ?? null,
    };
  });
}

function target(runDir, t, mode) {
  const so = t.second_opinion ?? {};
  const review = t.purchases.find((p) => p.role === "review");
  const res = review?.result ?? {};
  const atts = attemptsOf(runDir, t);
  const last = atts.length;
  const solPath = path.join(runDir, t.target_id, `attempt-${last}.sol`);
  return {
    id: t.target_id,
    bounty: t.bounty_id,
    cls: so.ground_truth_class ?? null,
    invariant: invariantOf(runDir, t.target_id),
    purchases: t.purchases.map((p) => ({
      role: p.role,
      intent: p.intent,
      status: Number(p.status),
      miner: p.miner_name ?? null,
      tx: p.settle_tx ?? null,
      mode: p.mode ?? mode,
    })),
    review: {
      verdict: so.verdict ?? null, // wrong | right | no_second_opinion
      reviewer: so.reviewer ?? null,
      defect: so.review_defect_found ?? null,
      label: res.verdict
        ? `“${res.verdict}”, ${res.vulnerability_count ?? 0} issues`
        : so.review_defect_found === false
          ? "No security defect found"
          : null,
      summary: so.review_summary ?? so.line ?? null,
      tx: so.review_settle_tx ?? null,
    },
    attempts: atts,
    sol: exists(solPath) ? fs.readFileSync(solPath, "utf8") : "",
    solved: !!t.solved,
    reason: t.resolution?.reason ?? null,
    commitTx: t.submit_tx ?? null,
    resolveTx: t.resolution?.resolveTx ?? null,
  };
}

function run(id) {
  const dir = path.join(HUNT, id);
  const r = readJson(path.join(dir, "run.json"));
  const mode = r.telegraph_mode;
  return {
    id,
    kind: mode === "live" ? "live" : "offline",
    label: mode === "live" ? `Live · ${r.at.slice(0, 10)}` : "Offline replay",
    at: r.at,
    note:
      NOTES[id] ??
      (mode === "live"
        ? ""
        : "Runs with no keys: a local Telegraph mock and the recorded model outputs (0 model calls, $0). The escrow, the exploits and the verifier are real and run locally."),
    backend: r.llm_backend,
    spend: r.telegraph_live_spend_this_run_usd ?? 0,
    modelCost: r.model_cost_usd ?? 0,
    modelCalls: r.model_calls ?? 0,
    solved: r.solved,
    withdrawTx: r.withdraw?.tx ?? null,
    targets: r.targets.map((t) => target(dir, t, mode)),
  };
}

const ids = fs
  .readdirSync(HUNT)
  .filter((d) => exists(path.join(HUNT, d, "run.json")));
const live = ids
  .filter((d) => d.startsWith("live-"))
  .filter((d) => readJson(path.join(HUNT, d, "run.json")).targets.length === 5)
  .sort()
  .reverse();
const mock = ids
  .filter((d) => d.startsWith("mock-"))
  .sort()
  .slice(-1);
const data = {
  built: new Date().toISOString().slice(0, 10),
  runs: [...live, ...mock].map(run),
};

const tpl = fs.readFileSync(
  path.join(ROOT, "scripts", "explorer", "template.html"),
  "utf8",
);
const app = fs.readFileSync(
  path.join(ROOT, "scripts", "explorer", "app.js"),
  "utf8",
);
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const html =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  tpl.replace("/*DATA*/", () => json).replace("/*APP*/", () => app) +
  "</html>\n";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(
  `wrote ${path.relative(ROOT, OUT)}: ${data.runs.length} runs (${data.runs.map((r) => r.label).join(", ")}), ${html.length} bytes`,
);
