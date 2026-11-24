import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTarget, listTargetIds, targetHashOf, TARGETS_DIR } from "../targets/index.js";
import { verifyTargetProof } from "../verifier/verify-target.js";

// Tests may read the reference exploits; the hunter may not (see real-hunter.test.js).
const REF = { "init-vault": "InitVaultExploit.sol", "share-vault": "ShareVaultExploit.sol", "token-vault": "TokenVaultExploit.sol" };
const ref = (id) => fs.readFileSync(path.join(TARGETS_DIR, "_reference", REF[id]), "utf8");
const NOOP =
  "pragma solidity 0.8.28; contract Exploit { constructor(address) payable {} function run() external {} receive() external payable {} }";

for (const id of Object.keys(REF)) {
  test(`${id}: the reference exploit is VALID under the deterministic verifier, reproducibly`, async () => {
    const t = await loadTarget(id);
    const a = await verifyTargetProof(ref(id), t);
    assert.equal(a.verdict.valid, true, a.verdict.reason);
    assert.equal(a.verdict.results.vulnerable.invariant_holds, false);
    assert.equal(a.verdict.results.patched.invariant_holds, true);
    const b = await verifyTargetProof(ref(id), t);
    assert.equal(a.verdictHash, b.verdictHash);
  });
  test(`${id}: a no-op proof is rejected (the honest scenario holds on both)`, async () => {
    const { verdict } = await verifyTargetProof(NOOP, await loadTarget(id));
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /still holds on the vulnerable/);
  });
}

test("the target hash binds the vulnerable source, the patched source and the scenario", async () => {
  assert.deepEqual(listTargetIds(), Object.keys(REF));
  const t = await loadTarget("init-vault");
  assert.equal(t.targetHash, targetHashOf(t.vulnerableSource, t.patchedSource, t.scenarioSource));
  assert.notEqual(t.targetHash, targetHashOf(t.vulnerableSource, t.patchedSource, t.scenarioSource + " "));
  assert.notEqual(t.targetHash, targetHashOf(t.patchedSource, t.vulnerableSource, t.scenarioSource));
});

test("compile errors come back with enough forge output to fix them", async () => {
  const { verdict } = await verifyTargetProof(
    "pragma solidity 0.8.28; contract Exploit { constructor(address t) payable { undefinedThing(); } function run() external {} }",
    await loadTarget("token-vault"),
  );
  assert.equal(verdict.stage, "compile");
  assert.match(verdict.reason, /undefinedThing|Undeclared identifier/);
});
