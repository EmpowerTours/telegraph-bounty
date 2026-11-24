import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "../mock/ask-server.js";
import {
  askTelegraph,
  assertBudget,
  liveSpentAtomic,
} from "../lib/telegraph.js";

const tmpLedger = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "r.ndjson");

test("budget guard refuses once conservative live spend would pass $1.50", () => {
  const ledger = tmpLedger();
  assert.equal(assertBudget(ledger), 0n);
  const row =
    JSON.stringify({ mode: "live", signed_amount_atomic: "10000" }) + "\n";
  fs.writeFileSync(ledger, row.repeat(148)); // 1.48 spent: 1.48 + 0.02 cap = 1.50, still allowed
  assert.equal(liveSpentAtomic(ledger), 1480000n);
  assert.doesNotThrow(() => assertBudget(ledger));
  fs.appendFileSync(ledger, row); // 1.49 + 0.02 > 1.50
  assert.throws(() => assertBudget(ledger), /budget guard/);
  // mock rows never count
  fs.appendFileSync(
    ledger,
    JSON.stringify({ mode: "mock", signed_amount_atomic: "10000" }) + "\n",
  );
  assert.equal(liveSpentAtomic(ledger), 1490000n);
});

test("mock: real x402 client pays the recorded challenge and gets a labelled mock answer", async () => {
  const s = await startMockServer();
  try {
    const ledger = tmpLedger();
    const r = await askTelegraph(
      { intent: "SECURITY_REVIEW_GENERAL", params: { target: "test" } },
      { mode: "mock", endpoint: s.url, ledgerPath: ledger },
    );
    assert.equal(r.status, 200);
    assert.equal(r.response.mock, true);
    assert.equal(r.signed_amount_atomic, "10000");
    assert.equal(r.payment.success, true);
    assert.match(r.receipt, /^mock-receipt-/);
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 1);
  } finally {
    await s.close();
  }
});

test("mock: a tampered payment signature is rejected with 402", async () => {
  const s = await startMockServer();
  try {
    const first = await fetch(s.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(first.status, 402);
    const pr = JSON.parse(
      Buffer.from(first.headers.get("payment-required"), "base64").toString(),
    );
    const accepted = pr.accepts.find((a) => a.network === "eip155:84532");
    const now = Math.floor(Date.now() / 1000);
    const forged = {
      x402Version: 2,
      accepted,
      payload: {
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: "0x0000000000000000000000000000000000000001",
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: String(now - 10),
          validBefore: String(now + 60),
          nonce: "0x" + "00".repeat(32),
        },
      },
    };
    const res = await fetch(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": Buffer.from(JSON.stringify(forged)).toString(
          "base64",
        ),
      },
      body: JSON.stringify({
        intent: "SECURITY_REVIEW_GENERAL",
        params: { target: "x" },
      }),
    });
    assert.equal(res.status, 402);
    const err = JSON.parse(
      Buffer.from(res.headers.get("payment-required"), "base64").toString(),
    ).error;
    assert.ok(["invalid_signature", "malformed_payment"].includes(err), err);
  } finally {
    await s.close();
  }
});
