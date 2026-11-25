// Hunter agent: reads an open bounty from the escrow, buys a security review from Telegraph
// (the autonomous machine-to-machine purchase), uses the answer to rank its exploit templates,
// self-checks candidates with the same deterministic verifier the bounty uses, commits
// keccak256(abi.encode(proofHash, hunter, bountyId)) on-chain, and hands the proof plus its own
// address to the bounty's verifier.
//
// The Telegraph answer only ORDERS the candidates. Whether anything gets paid is decided by the
// verifier's forge/anvil run, never by the model answer.
import fs from "node:fs";
import path from "node:path";
import { ROOT, targetHash, invariantHash, commitmentOf } from "../lib/chain.js";
import { askTelegraph } from "../lib/telegraph.js";
import { verifyProof, proofHashOf } from "../verifier/verify.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";

const TEMPLATES = [
  // [file, keywords in the review answer that promote it]
  [
    "proofs/ReentrancyExploit.sol",
    /reentran|re-entran|cwe-841|external call before state/i,
  ],
];
const MAX_TARGET_BYTES = 256; // on-chain slot size of SECURITY_REVIEW's `target` param

/** Review target built from OUR OWN demo source (VulnerableVault.withdrawAll), minified. */
export function reviewTarget() {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "VulnerableVault.sol"),
    "utf8",
  );
  const fn = src
    .match(/function withdrawAll\(\)[\s\S]*?\n {4}}/)[0]
    .replace(/,\s*"[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?([(){};=,]) ?/g, "$1");
  const target = `Own demo code, Solidity 0.8.28, VulnerableVault: ${fn}`;
  if (Buffer.byteLength(target) > MAX_TARGET_BYTES)
    throw new Error(`review target is ${Buffer.byteLength(target)} bytes`);
  return target;
}

export function rankTemplates(answer) {
  const text = JSON.stringify(answer ?? "");
  const hits = TEMPLATES.filter(([, re]) => re.test(text));
  const rest = TEMPLATES.filter(([, re]) => !re.test(text));
  return {
    order: [...hits, ...rest].map(([f]) => f),
    matched: hits.map(([f]) => f),
  };
}

/**
 * @param {object} o
 * @param {object} o.env           chain env from startAnvil()
 * @param {string} o.escrow        escrow address
 * @param {bigint} o.bountyId
 * @param {string} o.hunter        hunter account address (anvil dev account)
 * @param {{mode: "live"|"mock", endpoint?: string, network?: string}} o.telegraph
 * @param {(proofSource: string, hunter: string) => Promise<object>} o.handToVerifier
 * @param {(msg: string) => void} [o.log]
 */
export async function runHunter({
  env,
  escrow,
  bountyId,
  hunter,
  telegraph,
  handToVerifier,
  log = console.log,
}) {
  const [poster, , settled, , reward, tHash, iHash] =
    await env.pub.readContract({
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "bounties",
      args: [bountyId],
    });
  if (settled) throw new Error("bounty already settled");
  if (tHash !== targetHash())
    throw new Error(
      "bounty targetHash does not match the local vulnerable+patched sources",
    );
  if (iHash !== invariantHash())
    throw new Error("bounty invariantHash does not match the stated invariant");
  log(
    `hunter: bounty #${bountyId} by ${poster}, reward ${reward} wei, target ${tHash.slice(0, 10)}…`,
  );

  // 1. Paid machine-to-machine step: buy a security review of the target from Telegraph.
  const purchase = await askTelegraph(
    { intent: "SECURITY_REVIEW_GENERAL", params: { target: reviewTarget() } },
    { ...telegraph, purpose: `hunter triage for bounty #${bountyId}` },
  );
  log(
    `hunter: Telegraph ${purchase.mode} purchase status ${purchase.status}, miner ${purchase.miner_id}, ` +
      `receipt ${purchase.receipt}, cost_usd ${purchase.cost_usd}`,
  );
  const answer = purchase.status === 200 ? purchase.response?.result : null;
  const { order, matched } = rankTemplates(answer);
  log(
    `hunter: review matched templates ${JSON.stringify(matched)}; trying ${JSON.stringify(order)}`,
  );

  // 2. Self-check candidates with the public deterministic verifier before committing anything.
  for (const file of order) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const { verdict } = await verifyProof(source);
    log(
      `hunter: self-check ${file}: valid=${verdict.valid} (${verdict.reason})`,
    );
    if (!verdict.valid) continue;

    // 3. Commit on-chain, bound to this hunter and this bounty. Neither the exploit nor its
    // hash is revealed; a copier of the commitment can never be paid for it.
    const proofHash = proofHashOf(source);
    const commitment = commitmentOf(proofHash, hunter, bountyId);
    const hash = await env.wallet.writeContract({
      account: hunter,
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "submit",
      args: [bountyId, commitment],
    });
    const rcpt = await env.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error("submit reverted");
    log(
      `hunter: committed ${commitment.slice(0, 10)}… (proof ${proofHash.slice(0, 10)}…) in tx ${hash}`,
    );

    // 4. Hand the proof and the committing address to the bounty's verifier (off-chain).
    const resolution = await handToVerifier(source, hunter);
    return {
      purchase,
      proofFile: file,
      proofHash,
      commitment,
      submitTx: hash,
      resolution,
    };
  }
  return {
    purchase,
    proofFile: null,
    proofHash: null,
    commitment: null,
    submitTx: null,
    resolution: null,
  };
}
