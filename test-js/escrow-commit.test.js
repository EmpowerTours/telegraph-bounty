// Commit scheme end to end on a local anvil: the JS commitment matches the contract, a copier
// of the hunter's commitment is refused by the verifier service and by the contract, and the
// committing hunter is paid exactly once. Needs `forge build` output (npm test builds first).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEther } from "viem";
import {
  ROOT,
  startAnvil,
  artifact,
  deploy,
  send,
  targetHash,
  invariantHash,
  commitmentOf,
} from "../lib/chain.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";
import { proofHashOf } from "../verifier/verify.js";
import { resolveSubmission } from "../verifier/resolver.js";

test("only the committing hunter can be paid; a copied commitment is refused", async () => {
  const env = await startAnvil();
  const verdictDir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-commit-"));
  try {
    const [poster, verifier, hunter, copier] = env.accounts;
    const { address: escrow } = await deploy(
      env,
      poster,
      artifact("BountyEscrow.sol", "BountyEscrow"),
    );
    const block = await env.pub.getBlock();
    const read = (functionName, args) =>
      env.pub.readContract({
        address: escrow,
        abi: ESCROW_ABI,
        functionName,
        args,
      });

    // The poster cannot name itself as verifier.
    const self = await send(
      env,
      poster,
      escrow,
      ESCROW_ABI,
      "post",
      [poster, block.timestamp + 86400n, targetHash(), invariantHash()],
      { value: parseEther("1") },
    );
    assert.equal(self.status, "reverted");

    const ok = await send(
      env,
      poster,
      escrow,
      ESCROW_ABI,
      "post",
      [verifier, block.timestamp + 86400n, targetHash(), invariantHash()],
      { value: parseEther("1") },
    );
    assert.equal(ok.status, "success");
    const id = 0n;

    const source = fs.readFileSync(
      path.join(ROOT, "proofs/ReentrancyExploit.sol"),
      "utf8",
    );
    const proofHash = proofHashOf(source);
    const c = commitmentOf(proofHash, hunter, id);
    assert.equal(await read("commitmentOf", [id, proofHash, hunter]), c);
    assert.notEqual(commitmentOf(proofHash, copier, id), c);
    assert.notEqual(commitmentOf(proofHash, hunter, 1n), c);

    // Copier front-runs with the identical commitment; the hunter's own commit still lands.
    assert.equal(
      (await send(env, copier, escrow, ESCROW_ABI, "submit", [id, c])).status,
      "success",
    );
    assert.equal(
      (await send(env, hunter, escrow, ESCROW_ABI, "submit", [id, c])).status,
      "success",
    );

    await assert.rejects(
      resolveSubmission({
        env,
        escrow,
        bountyId: id,
        verifier,
        proofSource: source,
        hunter: copier,
        log: () => {},
        verdictDir,
      }),
      /no commitment for this proof by/,
    );
    const direct = await send(env, verifier, escrow, ESCROW_ABI, "resolve", [
      id,
      proofHash,
      copier,
      true,
      `0x${"00".repeat(32)}`,
    ]);
    assert.equal(direct.status, "reverted");

    const res = await resolveSubmission({
      env,
      escrow,
      bountyId: id,
      verifier,
      proofSource: source,
      hunter,
      log: () => {},
      verdictDir,
    });
    assert.equal(res.valid, true);
    assert.equal(await read("owed", [hunter]), parseEther("1"));
    assert.equal(await read("owed", [copier]), 0n);
    assert.equal(await read("verdictOf", [id, proofHash, hunter]), 2); // Paid

    // A second resolve of the same commitment is refused before anything runs.
    await assert.rejects(
      resolveSubmission({
        env,
        escrow,
        bountyId: id,
        verifier,
        proofSource: source,
        hunter,
        log: () => {},
        verdictDir,
      }),
      /already has a verdict/,
    );
  } finally {
    await env.stop();
    fs.rmSync(verdictDir, { recursive: true, force: true });
  }
});
