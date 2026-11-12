// Local stand-in for POST /engine/v1/ask, used because the testnet wallet is unfunded
// (the real endpoint answered 402 "insufficient_funds" to a signed payment; see
// evidence/telegraph-receipts.ndjson, mode:"live").
//
// It replays the 402 challenge recorded from the real endpoint (mock/recorded-402.json) and,
// when a PAYMENT-SIGNATURE arrives, checks it the way a facilitator's verify step would for the
// "exact" EVM scheme: x402Version 2, accepted requirement identical to one recorded, authorization
// to/value/validity window match, and the EIP-3009 TransferWithAuthorization signature recovers
// to `from`. Nothing is settled. The answer is a CANNED result, labelled mock everywhere.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  fs.readFileSync(path.join(HERE, "recorded-402.json"), "utf8"),
);
const accepts = recorded.decoded_payment_required.accepts;

// Canned answers in the response shape of the intent schemas (GET /engine/v1/intents/<NAME>).
const CANNED = {
  SECURITY_REVIEW_GENERAL: {
    verdict: "Insecure",
    vulnerability_count: 1,
    issues: [
      "CWE-841 reentrancy: external call before state update in withdrawAll()",
    ],
    summary:
      "MOCK ANSWER. withdrawAll() sends ether before zeroing the caller's balance, so a re-entrant caller is paid repeatedly.",
  },
};

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function challenge(res, error) {
  const pr = {
    ...recorded.decoded_payment_required,
    ...(error ? { error } : {}),
  };
  sendJson(res, 402, recorded.body, {
    "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64"),
  });
}

async function checkPayment(header) {
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  if (payload.x402Version !== 2) return "unsupported_x402_version";
  const acc = payload.accepted;
  const match = accepts.find((a) => JSON.stringify(a) === JSON.stringify(acc));
  if (
    !match ||
    match.scheme !== "exact" ||
    !match.network.startsWith("eip155:")
  )
    return "accepted_requirement_not_offered";
  const auth = payload.payload?.authorization;
  const sig = payload.payload?.signature;
  if (!auth || !sig) return "missing_authorization";
  if (auth.to.toLowerCase() !== match.payTo.toLowerCase())
    return "wrong_pay_to";
  if (BigInt(auth.value) !== BigInt(match.amount)) return "wrong_amount";
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(auth.validAfter) > now || BigInt(auth.validBefore) < now)
    return "authorization_not_valid_now";
  const ok = await verifyTypedData({
    address: auth.from,
    domain: {
      name: match.extra.name,
      version: match.extra.version,
      chainId: Number(match.network.split(":")[1]),
      verifyingContract: match.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: sig,
  });
  if (!ok) return "invalid_signature";
  return { payer: auth.from, network: match.network, amount: match.amount, nonce: auth.nonce };
}

export function startMockServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/engine/v1/ask")
      return sendJson(res, 404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const header = req.headers["payment-signature"];
    if (!header) return challenge(res);
    let verdict;
    try {
      verdict = await checkPayment(header);
    } catch {
      verdict = "malformed_payment";
    }
    if (typeof verdict === "string") return challenge(res, verdict);
    const result = CANNED[body.intent];
    if (!result)
      return sendJson(res, 422, {
        error: `mock has no canned answer for ${body.intent}`,
      });
    const signal = createHash("sha256")
      .update(JSON.stringify({ body, result, nonce: verdict.nonce }))
      .digest("hex");
    const settle = {
      success: true,
      transaction: "",
      network: verdict.network,
      payer: verdict.payer,
      mock: true,
    };
    sendJson(
      res,
      200,
      {
        mock: true,
        miner_id: "mock-miner",
        result,
        cost_usd: 0.01,
        signal_hash: `0x${signal}`,
      },
      {
        "payment-response": Buffer.from(JSON.stringify(settle)).toString(
          "base64",
        ),
        "x-telegraph-receipt": `mock-receipt-${signal.slice(0, 16)}`,
      },
    );
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}/engine/v1/ask`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startMockServer(Number(process.env.PORT || 8787));
  console.log(
    `mock Telegraph ask endpoint (canned answers, no settlement): ${url}`,
  );
}
