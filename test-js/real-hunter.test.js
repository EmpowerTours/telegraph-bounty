import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../lib/chain.js";
import { BudgetExceeded, CallBudget, createCliBackend, sha256 } from "../lib/llm.js";
import { loadTarget, listTargetIds, readTargetFile, TARGETS_DIR } from "../targets/index.js";
import {
  MODEL_PLAN,
  SYSTEM_PROMPT,
  buildPrompt,
  extractSolidity,
  huntTarget,
  writeExploit,
} from "../agent/real-hunter.js";

const REF_DIR = path.join(TARGETS_DIR, "_reference");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hunt-test-"));
const intel = { findings: [{ source: "review", miner: "m", text: { summary: "S" } }], ranked: [] };
const bad = "```solidity\npragma solidity 0.8.28; contract Exploit { constructor(address) payable {} function run() external {} }\n```";
const good = bad.replace("run() external {}", "run() external { /*GOOD*/ }");

/** Mock LLM: scripted responses, records every call. */
function scripted(responses) {
  const calls = [];
  return {
    name: "mock",
    calls,
    async complete(req) {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { text: r, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0.001, ms: 1 };
    },
  };
}
const stubVerify = async (code) => {
  const valid = code.includes("GOOD");
  return {
    verdict: { valid, stage: "execute", reason: valid ? "ok" : "invariant still holds on the vulnerable target", results: { vulnerable: { invariant_holds: !valid } } },
    verdictHash: "0x" + sha256(code),
  };
};

test("retry loop: feeds verifier output back, sonnet x3 then opus, stops at the first valid proof", async () => {
  const target = await loadTarget("init-vault");
  const llm = scripted([bad, bad, bad, good]);
  const dir = tmp();
  const w = await writeExploit({ target, intel, llm, verify: stubVerify, evidenceDir: dir });
  assert.equal(w.attempts.length, 4);
  assert.deepEqual(llm.calls.map((c) => c.model), MODEL_PLAN);
  assert.deepEqual(MODEL_PLAN, ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.ok(w.proof.includes("GOOD"));
  assert.ok(!llm.calls[0].prompt.includes("Previous attempts"));
  assert.match(llm.calls[3].prompt, /Attempt 3 \(claude-sonnet-5-5\)[\s\S]*invariant still holds/);
  // evidence: prompt hash, model, cost, forge result per attempt
  for (let n = 1; n <= 4; n++) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, "init-vault", `attempt-${n}.json`), "utf8"));
    const prompt = fs.readFileSync(path.join(dir, "init-vault", `attempt-${n}.prompt.txt`), "utf8");
    assert.equal(rec.prompt_sha256, sha256(SYSTEM_PROMPT + "\n\n" + prompt));
    assert.equal(rec.model, MODEL_PLAN[n - 1]);
    assert.equal(rec.cost_usd, 0.001);
    assert.ok(rec.forge_result);
  }
});

test("retry loop: valid on attempt 2 makes no further calls", async () => {
  const target = await loadTarget("token-vault");
  const llm = scripted([bad, good]);
  const w = await writeExploit({ target, intel, llm, verify: stubVerify });
  assert.equal(w.attempts.length, 2);
  assert.equal(llm.calls.length, 2);
});

test("retry loop: never more than 4 attempts; failed calls and missing code blocks count", async () => {
  const target = await loadTarget("share-vault");
  const llm = scripted([new Error("network"), "no code here", bad, bad, good]);
  const w = await writeExploit({ target, intel, llm, verify: stubVerify });
  assert.equal(w.attempts.length, 4);
  assert.equal(w.proof, null);
  assert.equal(w.attempts[0].error, "Error: network");
  assert.equal(w.attempts[1].stage, "extract");
});

test("retry loop: an exhausted spend guard stops the hunt (fail closed)", async () => {
  const target = await loadTarget("init-vault");
  const llm = createCliBackend({
    budget: new CallBudget(1),
    spawnImpl: async () => ({ code: 0, stdout: JSON.stringify({ result: bad }), stderr: "" }),
  });
  const w = await writeExploit({ target, intel, llm, verify: stubVerify });
  assert.equal(w.budgetExhausted, true);
  assert.equal(w.attempts.length, 2);
  assert.match(w.attempts[1].error, /BudgetExceeded/);
  assert.equal(llm.budget.calls, 1);
});

test("extractSolidity takes the last solidity block", () => {
  assert.equal(extractSolidity("a\n```solidity\nA\n```\nb\n```solidity\nB\n```"), "B\n");
  assert.equal(extractSolidity("nothing"), null);
});

test("prompts carry the vulnerable source and invariant, never the patched source", async () => {
  const patchedOnly = {
    "hook-vault": "function transfer(address to, uint amount) external nonReentrant",
    "init-vault": "_initialized = true;",
    "lend-pool": "oraclePrice",
    "share-vault": "VIRTUAL_SHARES",
    "token-vault": "token transferFrom failed",
  };
  for (const id of listTargetIds()) {
    const t = await loadTarget(id);
    assert.ok(t.patchedSource.includes(patchedOnly[id]) && !t.vulnerableSource.includes(patchedOnly[id]));
    const p = buildPrompt(t, intel, [{ n: 1, model: "m", feedback: "f", code: "c" }]);
    assert.ok(p.includes(t.vulnerableSource));
    assert.ok(p.includes(t.invariant));
    assert.ok(!p.includes(patchedOnly[id]), `${id} prompt leaks the patch`);
  }
});

// ---------------- the hidden reference-exploit directory ----------------

test("no-reference rule (static): hunter code never names the reference directory", () => {
  for (const f of ["agent/real-hunter.js", "lib/llm.js", "scripts/demo-hunt.js", "targets/index.js", "lib/telegraph.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!src.includes("_reference"), `${f} mentions _reference`);
  }
  for (const f of ["agent/real-hunter.js", "scripts/demo-hunt.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/["'`][^"'`]*targets\/(?!index\.js)/.test(src), `${f} reads targets/ outside the loader`);
  }
});

test("no-reference rule (loader): the reference directory is not a target and cannot be read", () => {
  assert.ok(fs.existsSync(REF_DIR));
  assert.deepEqual(listTargetIds(), ["hook-vault", "init-vault", "lend-pool", "share-vault", "token-vault"]);
  assert.throws(() => readTargetFile("_reference/InitVaultExploit.sol"), /hidden/);
  assert.throws(() => readTargetFile("init-vault/../_reference/ShareVaultExploit.sol"), /hidden/);
  assert.throws(() => readTargetFile("../package.json"), /outside/);
});

test("no-reference rule (runtime): a full mocked hunt touches no reference file and leaks none into prompts", async () => {
  const refTexts = fs.readdirSync(REF_DIR).filter((f) => f.endsWith(".sol")).map((f) => fs.readFileSync(path.join(REF_DIR, f), "utf8"));
  const touched = [];
  const names = ["readFileSync", "readFile", "openSync", "open", "readdirSync", "readdir", "createReadStream", "copyFileSync", "existsSync", "statSync", "lstatSync", "cpSync"];
  const saved = {};
  const savedP = {};
  const note = (a) => typeof a === "string" || a instanceof URL ? touched.push(String(a)) : null;
  for (const n of names)
    if (fs[n]) {
      saved[n] = fs[n];
      fs[n] = function (...args) { note(args[0]); return saved[n].apply(this, args); };
    }
  for (const n of ["readFile", "open", "readdir", "opendir"]) {
    savedP[n] = fs.promises[n];
    fs.promises[n] = function (...args) { note(args[0]); return savedP[n].apply(this, args); };
  }
  const llm = scripted([bad]);
  const buy = async (body) => ({
    request: body, mode: "mock", status: 200, miner_id: "m", cost_usd: 0.01, signed_amount_atomic: "10000",
    response: { miner_id: "m", result: body.intent === "VULNERABILITY_TRIAGE_GENERAL" ? { cvss_base_score: 7 } : { issues: ["X"], summary: "S" } },
  });
  const intents = Object.fromEntries(
    ["SMART_CONTRACT_AUDIT_GENERAL", "SECURITY_REVIEW_GENERAL", "VULNERABILITY_TRIAGE_GENERAL", "CODE_PATCH_VERIFY_GENERAL"].map((n) => [n, { usable: true }]),
  );
  try {
    for (const id of listTargetIds()) {
      const target = await loadTarget(id);
      // real deterministic verifier: compiles and runs the (useless) proof on anvil
      const r = await huntTarget({ target, telegraph: { mode: "mock" }, intents, llm, buy, log: () => {} });
      assert.equal(r.solved, false);
      assert.equal(r.attempts.length, 4);
    }
  } finally {
    for (const n of Object.keys(saved)) fs[n] = saved[n];
    for (const n of Object.keys(savedP)) fs.promises[n] = savedP[n];
  }
  assert.ok(touched.length > 0, "spy saw no reads");
  const bad1 = touched.filter((p) => p.includes("_reference"));
  assert.deepEqual(bad1, []);
  for (const c of llm.calls)
    for (const ref of refTexts) assert.ok(!c.prompt.includes(ref) && !c.system.includes(ref));
});

// ---------------- Telegraph param limit (found in the first live run) ----------------

test("review params are compacted under the router's 2000-char limit and still compile to the same ABI", async () => {
  const { compactSolidity, MAX_PARAM_CHARS } = await import("../agent/real-hunter.js");
  const { compileTargetFile } = await import("../verifier/verify-target.js");
  for (const id of listTargetIds()) {
    const t = await loadTarget(id);
    const c = compactSolidity(t.vulnerableSource);
    assert.ok(c.length <= MAX_PARAM_CHARS, `${id}: ${c.length}`);
    const a = compileTargetFile(t.vulnerableSource, t.vulnerable.file).contracts;
    const b = compileTargetFile("// SPDX-License-Identifier: MIT\n" + c, t.vulnerable.file).contracts;
    for (const name of Object.keys(a))
      assert.deepEqual(b[name].abi.filter((x) => x.type !== "event"), a[name].abi.filter((x) => x.type !== "event"), `${id}.${name}`);
  }
});

test("a request with a param over 2000 chars is skipped, not bought", async () => {
  const { buyIntel } = await import("../agent/real-hunter.js");
  const t = await loadTarget("init-vault");
  const big = { ...t, vulnerableSource: t.vulnerableSource + "\n" + "contract Pad { uint256 x; }\n".repeat(200) };
  let bought = 0;
  const r = await buyIntel({
    target: big,
    telegraph: { mode: "mock" },
    intents: { SECURITY_REVIEW_GENERAL: { usable: true }, VULNERABILITY_TRIAGE_GENERAL: { usable: true } },
    buy: async () => { bought++; throw new Error("must not be called"); },
  });
  assert.equal(bought, 0);
  assert.ok(r.skipped.some((s) => /over the 2000 limit/.test(s.reason)));
});
