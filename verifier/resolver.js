// The bounty's verifier service: receives a proof and the address that claims it, checks that
// this address itself committed keccak256(abi.encode(proofHash, hunter, bountyId)) on-chain and
// that the commitment has no verdict yet, runs the deterministic verifier, stores the verdict
// JSON as evidence, and resolves on-chain for that hunter.
import fs from "node:fs";
import path from "node:path";
import { ROOT, targetHash, invariantHash, commitmentOf } from "../lib/chain.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";
import { verifyProof, proofHashOf } from "./verify.js";
import { verifyTargetProof } from "./verify-target.js";

export const VERDICT_DIR = path.join(ROOT, "evidence", "verdicts");

export async function resolveSubmission({
  env,
  escrow,
  bountyId,
  verifier,
  proofSource,
  hunter, // address the proof was handed in by; must be the address that committed it
  log = console.log,
  target = null, // a loaded held-out target (targets/index.js); null = the original demo vault
  verdictDir = VERDICT_DIR,
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
  const expectT = target ? target.targetHash : targetHash();
  const expectI = target ? target.invariantHash : invariantHash();
  if (tHash !== expectT || iHash !== expectI)
    throw new Error("bounty does not match local target/invariant");
  if (!/^0x[0-9a-fA-F]{40}$/.test(hunter ?? ""))
    throw new Error("resolveSubmission needs the hunter address the proof came from");
  const commitment = commitmentOf(proofHash, hunter, bountyId);
  const onChain = await env.pub.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "commitmentOf",
    args: [bountyId, proofHash, hunter],
  });
  if (onChain !== commitment)
    throw new Error("local commitment encoding differs from BountyEscrow.commitmentOf");
  const [committedAt, prior] = await env.pub.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "commits",
    args: [bountyId, commitment, hunter],
  });
  if (committedAt === 0n)
    throw new Error(
      `no commitment for this proof by ${hunter} on bounty #${bountyId} (never committed, or committed by someone else)`,
    );
  if (prior !== 0) throw new Error("this commitment already has a verdict");

  const { verdict, verdictHash } = target
    ? await verifyTargetProof(proofSource, target)
    : await verifyProof(proofSource);
  fs.mkdirSync(verdictDir, { recursive: true });
  const file = path.join(verdictDir, `${proofHash}.json`);
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
    args: [bountyId, proofHash, hunter, verdict.valid, verdictHash],
  });
  const rcpt = await env.pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("resolve reverted");
  log(`verifier: resolve(valid=${verdict.valid}) tx ${hash}`);
  return {
    hunter,
    proofHash,
    commitment,
    committedAt: committedAt.toString(),
    verdictHash,
    valid: verdict.valid,
    reason: verdict.reason,
    resolveTx: hash,
    verdictFile: path.relative(ROOT, file),
  };
}
