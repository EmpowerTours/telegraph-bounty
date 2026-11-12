import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/chain.js";
import { verifyProof } from "../verifier/verify.js";

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("valid reentrancy proof is accepted and the verdict hash is reproducible", async () => {
  const src = read("proofs/ReentrancyExploit.sol");
  const a = await verifyProof(src);
  const b = await verifyProof(src);
  assert.equal(a.verdict.valid, true);
  assert.equal(a.verdict.results.vulnerable.invariant_holds, false);
  assert.equal(a.verdict.results.patched.invariant_holds, true);
  assert.equal(a.verdictHash, b.verdictHash);
});

test("no-op proof is rejected: invariant holds on the vulnerable target", async () => {
  const { verdict } = await verifyProof(read("proofs/bogus/NoopExploit.sol"));
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /still holds on the vulnerable/);
});

test("force-feed proof is rejected: it cannot fake insolvency", async () => {
  const { verdict } = await verifyProof(
    read("proofs/bogus/ForceFeedExploit.sol"),
  );
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /still holds on the vulnerable/);
  assert.ok(BigInt(verdict.results.vulnerable.vault_balance_wei) > BigInt(verdict.results.vulnerable.total_deposits_wei));
});

test("proofs with imports are rejected statically", async () => {
  const src =
    'pragma solidity 0.8.28;\nimport "forge-std/Vm.sol";\ncontract Exploit { constructor(address) payable {} function run() external {} }\n';
  const { verdict } = await verifyProof(src);
  assert.equal(verdict.stage, "static");
  assert.equal(verdict.valid, false);
});

test("proofs that do not compile or have the wrong ABI are rejected", async () => {
  const bad = await verifyProof(
    "pragma solidity 0.8.28; contract Exploit { function run( }",
  );
  assert.equal(bad.verdict.stage, "compile");
  const wrongAbi = await verifyProof(
    "pragma solidity 0.8.28; contract Exploit { constructor() payable {} function run() external {} }",
  );
  assert.equal(wrongAbi.verdict.stage, "compile");
  assert.match(wrongAbi.verdict.reason, /constructor\(address vault\) payable/);
});

test("a reverting constructor is recorded as a rejection, not a crash", async () => {
  const src =
    "pragma solidity 0.8.28; contract Exploit { constructor(address) payable { revert(); } function run() external {} }";
  const { verdict } = await verifyProof(src);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.results.vulnerable.deploy_status, "reverted");
});
