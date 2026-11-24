// Pluggable LLM backend for the hunter's exploit writer, with spend guards.
//
// Backends:
//   api    -> Anthropic SDK (used when ANTHROPIC_API_KEY is set, e.g. by judges). Guarded by a
//             per-run USD cap computed from reported usage. Before each call the worst case
//             (input upper bound + max_tokens of output) is reserved; a call that could pass the
//             cap is refused. Unknown model price or missing usage fails closed.
//   cli    -> local Claude Code CLI, headless: `claude -p --model <m> --output-format json
//             --max-turns 1 --tools ""`, prompt on stdin, run from an empty temp directory with no
//             settings, MCP servers or tools. Guarded by a hard cap on model calls per run.
//   replay -> offline: replays model outputs recorded by an earlier live run (evidence/hunt/).
//             No model is called. Used by the offline mock demo.
// Tests inject their own backend object with the same complete() shape.
//
// No key is read or printed here. The api backend relies on the SDK's own env lookup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** USD per million tokens (Anthropic first-party list prices, checked 2026-11-23). */
export const PRICES = {
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheWrite: 2.5,
    cacheRead: 0.1,
  },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
export const API_USD_CAP = 3;
export const CLI_CALL_CAP = 12;
export const MAX_OUTPUT_TOKENS = 16000;
export const CLI_TIMEOUT_MS = 420_000;

export class BudgetExceeded extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BudgetExceeded";
  }
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function priceOf(model) {
  const p = PRICES[model];
  if (!p)
    throw new BudgetExceeded(
      `no price known for model ${model}; refusing (fail closed)`,
    );
  return p;
}

/** Cost of one response from its usage block. Throws (fail closed) on unknown model. */
export function costOfUsage(model, usage) {
  const p = priceOf(model);
  const n = (x) => (Number.isFinite(x) ? x : 0);
  return (
    (n(usage.input_tokens) * p.input +
      n(usage.cache_creation_input_tokens) * p.cacheWrite +
      n(usage.cache_read_input_tokens) * p.cacheRead +
      n(usage.output_tokens) * p.output) /
    1e6
  );
}

/** Upper bound on input tokens from text length (at least 1 token per 2 characters). */
export const inputTokenBound = (chars) => Math.ceil(chars / 2) + 64;

/** Per-run USD cap for the api backend. */
export class UsdBudget {
  constructor(capUsd = API_USD_CAP) {
    this.capUsd = capUsd;
    this.spentUsd = 0;
    this.calls = 0;
  }
  worstCase(model, promptChars, maxTokens) {
    const p = priceOf(model);
    return (
      (inputTokenBound(promptChars) * p.input + maxTokens * p.output) / 1e6
    );
  }
  /** Refuses (throws BudgetExceeded) if the worst case of this call could pass the cap. */
  reserve(model, promptChars, maxTokens) {
    const w = this.worstCase(model, promptChars, maxTokens);
    if (this.spentUsd + w > this.capUsd)
      throw new BudgetExceeded(
        `USD guard: spent ${this.spentUsd.toFixed(4)} + worst case ${w.toFixed(4)} > cap ${this.capUsd}`,
      );
    this.calls++;
    return w;
  }
  /** Book the actual cost. Missing usage books the reserved worst case. */
  settle(model, usage, reserved) {
    const c = usage ? costOfUsage(model, usage) : reserved;
    this.spentUsd += c;
    return c;
  }
}

/** Hard cap on model calls per run (cli backend). Every spawn counts, even one that fails. */
export class CallBudget {
  constructor(max = CLI_CALL_CAP) {
    this.max = max;
    this.calls = 0;
  }
  take() {
    if (this.calls >= this.max)
      throw new BudgetExceeded(
        `call guard: ${this.calls} model calls used, cap ${this.max}`,
      );
    this.calls++;
  }
}

/** API backend (Anthropic SDK). `client` is injectable for tests. */
export async function createApiBackend({
  budget = new UsdBudget(),
  client = null,
} = {}) {
  if (!client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ maxRetries: 0 });
  }
  return {
    name: "api",
    budget,
    async complete({ model, system, prompt, maxTokens = MAX_OUTPUT_TOKENS }) {
      const reserved = budget.reserve(
        model,
        system.length + prompt.length,
        maxTokens,
      );
      const started = Date.now();
      let res;
      try {
        res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          thinking: { type: "adaptive" },
          system,
          messages: [{ role: "user", content: prompt }],
        });
      } catch (e) {
        // A failed request may still have been billed; book the worst case (fail closed).
        budget.settle(model, null, reserved);
        throw e;
      }
      if (res.model && res.model !== model) {
        budget.settle(model, null, reserved);
        throw new BudgetExceeded(
          `response served by ${res.model}, expected ${model}`,
        );
      }
      const costUsd = budget.settle(model, res.usage, reserved);
      const text = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        text,
        model,
        stop_reason: res.stop_reason,
        usage: res.usage,
        cost_usd: costUsd,
        cost_basis: "computed from usage at list price",
        ms: Date.now() - started,
      };
    },
  };
}

/** argv for one headless CLI call. Exported so a test can pin the no-tools flags. */
export function cliArgs(model, system) {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--system-prompt",
    system,
  ];
}

function defaultSpawn(cmd, args, { input, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

/** CLI backend (local Claude Code, headless). `spawnImpl` is injectable for tests. */
export function createCliBackend({
  budget = new CallBudget(),
  spawnImpl = defaultSpawn,
  command = process.env.CLAUDE_BIN || "claude",
  timeoutMs = CLI_TIMEOUT_MS,
} = {}) {
  return {
    name: "cli",
    budget,
    async complete({ model, system, prompt }) {
      budget.take();
      // Empty working directory: even if a tool slipped through, there is nothing to read.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hunter-llm-"));
      const started = Date.now();
      try {
        const r = await spawnImpl(command, cliArgs(model, system), {
          input: prompt,
          cwd,
          timeoutMs,
        });
        if (r.timedOut)
          throw new Error(`claude CLI timed out after ${timeoutMs} ms`);
        let j;
        try {
          j = JSON.parse(r.stdout);
        } catch {
          throw new Error(
            `claude CLI exit ${r.code}: unparseable output (${r.stderr.slice(0, 300)})`,
          );
        }
        if (j.is_error)
          throw new Error(
            `claude CLI error: ${String(j.result).slice(0, 300)}`,
          );
        return {
          text: j.result ?? "",
          model,
          stop_reason: j.stop_reason ?? null,
          usage: j.usage ?? null,
          cost_usd: j.total_cost_usd ?? null,
          cost_basis:
            "reported by claude CLI (list price; billed to the CLI plan)",
          ms: Date.now() - started,
        };
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Replay backend: returns recorded responses per target in attempt order.
 * @param {Record<string, string[]>} recordings targetId -> response texts
 */
export function createReplayBackend(recordings, source = "recording") {
  const next = {};
  return {
    name: "replay",
    source,
    budget: null,
    async complete({ model, targetId }) {
      const list = recordings[targetId] ?? [];
      const i = next[targetId] ?? 0;
      next[targetId] = i + 1;
      if (i >= list.length)
        throw new Error(
          `replay: no recorded response ${i + 1} for ${targetId}`,
        );
      return {
        text: list[i],
        model,
        stop_reason: "replay",
        usage: null,
        cost_usd: 0,
        cost_basis: `replayed from ${source}, no model called`,
        ms: 0,
      };
    },
  };
}
