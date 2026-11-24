import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/chain.js";
import {
  BudgetExceeded,
  CallBudget,
  UsdBudget,
  cliArgs,
  costOfUsage,
  createApiBackend,
  createCliBackend,
} from "../lib/llm.js";

const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

test("cost is computed from usage at list price; unknown model fails closed", () => {
  assert.equal(costOfUsage("claude-sonnet-5-5", usage(1_000_000, 0)), 2);
  assert.equal(costOfUsage("claude-opus-5-5", usage(0, 1_000_000)), 20);
  assert.throws(() => costOfUsage("claude-unknown", usage(1, 1)), BudgetExceeded);
  assert.throws(() => new UsdBudget(3).reserve("claude-unknown", 10, 10), BudgetExceeded);
});

test("USD guard refuses a call whose worst case could pass the $3 cap", () => {
  const b = new UsdBudget(3);
  // worst case of a 16k-output opus call with a 20k-char prompt: (10064*4 + 16000*20)/1e6
  const w = b.reserve("claude-opus-5-5", 20_000, 16_000);
  assert.ok(Math.abs(w - 0.360256) < 1e-9);
  b.settle("claude-opus-5-5", usage(5_000, 4_000), w);
  assert.ok(Math.abs(b.spentUsd - 0.1) < 1e-9);
  b.spentUsd = 2.7;
  assert.throws(() => b.reserve("claude-opus-5-5", 20_000, 16_000), /USD guard/);
  assert.doesNotThrow(() => b.reserve("claude-sonnet-5-5", 20_000, 16_000)); // 2.7 + 0.18 <= 3
});

test("missing usage books the reserved worst case (fail closed)", () => {
  const b = new UsdBudget(3);
  const w = b.reserve("claude-sonnet-5-5", 1000, 16_000);
  b.settle("claude-sonnet-5-5", null, w);
  assert.equal(b.spentUsd, w);
});

test("api backend stops calling the client once the cap would be passed", async () => {
  let calls = 0;
  const client = {
    messages: {
      create: async (req) => {
        calls++;
        assert.deepEqual(req.thinking, { type: "adaptive" });
        return { model: req.model, stop_reason: "end_turn", usage: usage(100_000, 16_000), content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const llm = await createApiBackend({ budget: new UsdBudget(3), client });
  const args = { model: "claude-opus-5-5", system: "s", prompt: "p".repeat(10_000) };
  let ok = 0;
  try {
    for (let i = 0; i < 50; i++) {
      await llm.complete(args);
      ok++;
    }
  } catch (e) {
    assert.ok(e instanceof BudgetExceeded, e.message);
  }
  assert.equal(calls, ok);
  assert.ok(llm.budget.spentUsd <= 3, `spent ${llm.budget.spentUsd}`);
  assert.ok(ok >= 1 && ok < 50);
});

test("api backend fails closed when another model served the request", async () => {
  const client = { messages: { create: async () => ({ model: "claude-x", usage: usage(1, 1), content: [] }) } };
  const llm = await createApiBackend({ budget: new UsdBudget(3), client });
  await assert.rejects(llm.complete({ model: "claude-sonnet-5-5", system: "s", prompt: "p" }), BudgetExceeded);
  assert.ok(llm.budget.spentUsd > 0);
});

test("CLI guard: hard cap of 12 model calls per run, failed calls count", async () => {
  const b = new CallBudget(12);
  for (let i = 0; i < 12; i++) b.take();
  assert.throws(() => b.take(), /call guard/);

  let spawned = 0;
  const llm = createCliBackend({
    budget: new CallBudget(12),
    spawnImpl: async () => {
      spawned++;
      return spawned % 2
        ? { code: 1, stdout: "", stderr: "boom", timedOut: false }
        : { code: 0, stdout: JSON.stringify({ result: "x", is_error: false, total_cost_usd: 0.01 }), stderr: "" };
    },
  });
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await llm.complete({ model: "claude-sonnet-5-5", system: "s", prompt: "p" });
    } catch (e) {
      if (e instanceof BudgetExceeded) refused++;
    }
  }
  assert.equal(spawned, 12);
  assert.equal(refused, 8);
});

test("CLI backend: headless, no tools, one turn, prompt on stdin, empty temp cwd", async () => {
  const a = cliArgs("claude-sonnet-5-5", "SYS");
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.equal(a[0], "-p");
  assert.equal(flag("--model"), "claude-sonnet-5-5");
  assert.equal(flag("--output-format"), "json");
  assert.equal(flag("--max-turns"), "1");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--setting-sources"), "");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(flag("--system-prompt"), "SYS");
  assert.ok(!a.some((x) => x.includes("PROMPT-BODY")), "prompt must not be on the command line");

  let seen;
  const llm = createCliBackend({
    spawnImpl: async (cmd, args, opts) => {
      seen = { ...opts, entries: fs.readdirSync(opts.cwd) };
      return { code: 0, stdout: JSON.stringify({ result: "done", usage: {}, total_cost_usd: 0.02 }), stderr: "" };
    },
  });
  const r = await llm.complete({ model: "claude-sonnet-5-5", system: "S", prompt: "PROMPT-BODY" });
  assert.equal(r.text, "done");
  assert.equal(r.cost_usd, 0.02);
  assert.equal(seen.input, "PROMPT-BODY");
  assert.deepEqual(seen.entries, []);
  assert.ok(!path.resolve(seen.cwd).startsWith(ROOT));
  assert.ok(!fs.existsSync(seen.cwd), "temp cwd is removed");
});

test("CLI backend: a timeout is an error, not a hang", async () => {
  const llm = createCliBackend({ spawnImpl: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }), timeoutMs: 5 });
  await assert.rejects(llm.complete({ model: "claude-sonnet-5-5", system: "s", prompt: "p" }), /timed out/);
});
