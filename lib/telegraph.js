// Paid Telegraph inference over x402 (same client stack as the reference ask.js).
//
// Modes:
//   live -> https://devnode.telegraphprotocol.com/engine/v1/ask, paid from the testnet-only wallet
//           at ~/.empowertours/telegraph-sepolia.json (key read from file, never printed or logged)
//   mock -> local replay server (mock/ask-server.js) that serves the 402 challenge recorded from
//           the real endpoint and checks the EIP-3009 signature; signed by an in-memory throwaway
//           key that never holds funds. Mock records are labelled mode:"mock" everywhere.
//
// Spend guards (live): x402 spendControls cap of $0.02 per payment, a policy that only allows the
// "exact" scheme on the chosen testnet with amount <= 20000 atomic USDC, and a ledger check that
// refuses a request if the conservative live total (every signed payment counted as spent) would
// exceed $0.30. Every attempt is appended to evidence/telegraph-receipts.ndjson (append-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  wrapFetchWithPaymentFromConfig,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIVE_ENDPOINT =
  "https://devnode.telegraphprotocol.com/engine/v1/ask";
export const LEDGER = path.join(ROOT, "evidence", "telegraph-receipts.ndjson");
export const MAX_PER_REQUEST_ATOMIC = 20000n; // $0.02 in 6-decimal USDC
export const MAX_TOTAL_ATOMIC = 300000n; // $0.30

export const NETWORKS = {
  base: {
    id: "eip155:84532",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  sepolia: {
    id: "eip155:11155111",
    usdc: "0xcc194e1a843B658526D0D5C431f670028582Ae17",
  },
};

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Conservative live spend: every live attempt that signed a payment counts as spent. */
export function liveSpentAtomic(ledgerPath = LEDGER) {
  return readLedger(ledgerPath)
    .filter((r) => r.mode === "live" && r.signed_amount_atomic)
    .reduce((s, r) => s + BigInt(r.signed_amount_atomic), 0n);
}

export function assertBudget(ledgerPath = LEDGER) {
  const spent = liveSpentAtomic(ledgerPath);
  if (spent + MAX_PER_REQUEST_ATOMIC > MAX_TOTAL_ATOMIC) {
    throw new Error(
      `budget guard: live spend ${spent} + per-request cap ${MAX_PER_REQUEST_ATOMIC} exceeds total cap ${MAX_TOTAL_ATOMIC} (atomic USDC)`,
    );
  }
  return spent;
}

function loadLiveAccount() {
  const file = path.join(
    os.homedir(),
    ".empowertours",
    "telegraph-sepolia.json",
  );
  const wallet = JSON.parse(fs.readFileSync(file, "utf8"));
  return privateKeyToAccount(wallet.private_key);
}

/**
 * Buy one Telegraph answer. Returns the ledger record (also appended to the ledger).
 * @param {object} body  {"intent": "...", "params": {...}}
 * @param {{mode?: "live"|"mock", endpoint?: string, network?: "base"|"sepolia", ledgerPath?: string, purpose?: string}} opts
 */
export async function askTelegraph(body, opts = {}) {
  const mode = opts.mode || "mock";
  const ledgerPath = opts.ledgerPath || LEDGER;
  const net = NETWORKS[opts.network || "base"];
  if (!net) throw new Error("network must be base or sepolia");
  if (mode !== "live" && mode !== "mock")
    throw new Error("mode must be live or mock");
  const endpoint = mode === "live" ? LIVE_ENDPOINT : opts.endpoint;
  if (!endpoint)
    throw new Error("mock mode needs opts.endpoint (start mock/ask-server.js)");
  if (mode === "live") assertBudget(ledgerPath);

  const account =
    mode === "live"
      ? loadLiveAccount()
      : privateKeyToAccount(generatePrivateKey());
  let selected = null;
  const fetchPaid = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: net.id, client: new ExactEvmScheme(account) }],
    spendControls: {
      maxAmountPerPayment: "$0.02",
      allowedAssets: [
        {
          network: net.id,
          asset: net.usdc,
          maxAmountPerPayment: MAX_PER_REQUEST_ATOMIC.toString(),
        },
      ],
    },
    policies: [
      (_version, reqs) =>
        reqs.filter(
          (r) =>
            r.scheme === "exact" &&
            r.network === net.id &&
            r.asset?.toLowerCase() === net.usdc.toLowerCase() &&
            BigInt(r.amount) <= MAX_PER_REQUEST_ATOMIC,
        ),
    ],
    paymentRequirementsSelector: (_version, reqs) => {
      selected = reqs[0];
      return reqs[0];
    },
  });

  const started = Date.now();
  let res,
    text,
    error = null;
  try {
    res = await fetchPaid(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    error = String(e?.message || e);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const payHeader = res?.headers.get("PAYMENT-RESPONSE");
  // On a rejected payment the server answers 402 again; its PAYMENT-REQUIRED header carries the reason.
  let paymentRequiredError = null;
  const prHeader = res?.status === 402 ? res.headers.get("PAYMENT-REQUIRED") : null;
  if (prHeader) {
    try {
      paymentRequiredError = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")).error ?? null;
    } catch {
      paymentRequiredError = "unparseable PAYMENT-REQUIRED header";
    }
  }
  const record = {
    at: new Date().toISOString(),
    mode,
    purpose: opts.purpose || null,
    endpoint,
    payer: account.address,
    network: net.id,
    status: res?.status ?? null,
    ms: Date.now() - started,
    request: body,
    signed_amount_atomic: selected ? String(selected.amount) : null,
    pay_to: selected?.payTo ?? null,
    response: data,
    miner_id: data?.miner_id ?? null,
    cost_usd: data?.cost_usd ?? null,
    signal_hash: data?.signal_hash ?? null,
    payment: payHeader ? decodePaymentResponseHeader(payHeader) : null,
    receipt: res?.headers.get("X-TELEGRAPH-RECEIPT") ?? null,
    payment_required_error: paymentRequiredError,
    error,
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(record) + "\n");
  return record;
}
