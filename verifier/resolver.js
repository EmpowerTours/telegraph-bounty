// The bounty's verifier service: checks the proof was committed on-chain, runs the
// deterministic verifier, stores the verdict JSON as evidence, and resolves on-chain.
import fs from "node:fs";
import path from "node:path";
import { ROOT, targetHash, invariantHash } from "../lib/chain.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";
import { verifyProof, proofHashOf } from "./verify.js";

export const VERDICT_DIR = path.join(ROOT, "evidence", "verdicts");

export async function resolveSubmission({
  env,
  escrow,
  bountyId,
  verifier,
  proofSource,
  log = console.log,
}) {
  const proofHash = proofHashOf(proofSource);
  const [, , , vAddr, , tHash, iHash] = await env.pub.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "bounties",
    args: [bountyId],
  });
  if (vAddr.toLowerCase() !== verifier.toLowerCase())
    throw new Error("this service is not the bounty's verifier");
  if (tHash !== targetHash() || iHash !== invariantHash())
    throw new Error("bounty does not match local target/invariant");
  const hunter = await env.pub.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "submitterOf",
    args: [bountyId, proofHash],
  });
  if (/^0x0{40}$/i.test(hunter))
    throw new Error("proof hash was never committed on-chain");

  const { verdict, verdictHash } = await verifyProof(proofSource);
  fs.mkdirSync(VERDICT_DIR, { recursive: true });
  const file = path.join(VERDICT_DIR, `${proofHash}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ verdict_hash: verdictHash, ...verdict }, null, 2) + "\n",
  );
  log(
    `verifier: proof ${proofHash.slice(0, 10)}… valid=${verdict.valid} (${verdict.reason})`,
  );

  const hash = await env.wallet.writeContract({
    account: verifier,
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "resolve",
    args: [bountyId, proofHash, verdict.valid, verdictHash],
  });
  const rcpt = await env.pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("resolve reverted");
  log(`verifier: resolve(valid=${verdict.valid}) tx ${hash}`);
  return {
    hunter,
    proofHash,
    verdictHash,
    valid: verdict.valid,
    reason: verdict.reason,
    resolveTx: hash,
    verdictFile: path.relative(ROOT, file),
  };
}
