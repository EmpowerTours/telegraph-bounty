// Local-only chain helpers: spawn anvil, load forge artifacts, build viem clients.
// Accounts are anvil's unlocked dev accounts (eth_sendTransaction), so no key material
// appears in this repo.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  concat,
  encodeAbiParameters,
} from "viem";
import { foundry } from "viem/chains";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FOUNDRY_BIN = path.join(os.homedir(), ".foundry", "bin");
export const FORGE = process.env.FORGE || path.join(FOUNDRY_BIN, "forge");
export const ANVIL = process.env.ANVIL || path.join(FOUNDRY_BIN, "anvil");

/** Fixed genesis timestamp so verifier runs are reproducible. */
export const GENESIS_TIMESTAMP = 1_767_225_600; // 2026-01-01T00:00:00Z

export async function startAnvil({ timestamp = GENESIS_TIMESTAMP } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(
      ANVIL,
      [
        "--port",
        String(port),
        "--timestamp",
        String(timestamp),
        "--accounts",
        "10",
      ],
      {
        stdio: "ignore",
      },
    );
    const url = `http://127.0.0.1:${port}`;
    let exited = false;
    proc.on("exit", () => (exited = true));
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        if (r.ok) {
          const pub = createPublicClient({
            chain: foundry,
            transport: http(url),
          });
          const accounts = await rpc(url, "eth_accounts");
          return {
            url,
            pub,
            wallet: createWalletClient({
              chain: foundry,
              transport: http(url),
            }),
            accounts,
            stop: () =>
              new Promise((resolve) => {
                if (exited) return resolve();
                proc.once("exit", resolve);
                proc.kill("SIGTERM");
              }),
          };
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    proc.kill("SIGKILL");
  }
  throw new Error("could not start anvil");
}

export async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export function forgeBuild(root = ROOT) {
  execFileSync(FORGE, ["build", "--root", root], {
    stdio: "pipe",
    timeout: 180_000,
  });
}

export function artifact(file, name, outDir = path.join(ROOT, "out")) {
  const j = JSON.parse(
    fs.readFileSync(path.join(outDir, file, `${name}.json`), "utf8"),
  );
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export async function deploy(
  env,
  from,
  { abi, bytecode },
  args = [],
  value = 0n,
) {
  const hash = await env.wallet.deployContract({
    account: from,
    abi,
    bytecode,
    args,
    value,
  });
  const rcpt = await env.pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`deploy reverted (${hash})`);
  return { address: rcpt.contractAddress, hash };
}

/** Send a tx and return the receipt; reverts are returned, not thrown (gas is pinned so no estimate). */
export async function send(
  env,
  from,
  address,
  abi,
  functionName,
  args = [],
  { value = 0n, gas = 5_000_000n } = {},
) {
  const hash = await env.wallet.writeContract({
    account: from,
    address,
    abi,
    functionName,
    args,
    value,
    gas,
  });
  return env.pub.waitForTransactionReceipt({ hash });
}

/** Hash that binds a bounty to the exact vulnerable + patched source code. */
export function targetHash(root = ROOT) {
  const v = fs.readFileSync(path.join(root, "src", "VulnerableVault.sol"));
  const p = fs.readFileSync(path.join(root, "src", "PatchedVault.sol"));
  return keccak256(concat([keccak256(v), keccak256(p)]));
}

// Solvency, not equality: ether can be force-fed into any contract (selfdestruct), so equality
// could be "broken" by a proof that sniffs the target and force-feeds only the vulnerable one.
// balance < totalDeposits can only come from the vault's own code paying out more than it books.
export const INVARIANT = "address(vault).balance >= vault.totalDeposits()";
export const invariantHash = () => keccak256(toBytes(INVARIANT));

/**
 * The on-chain commitment for a proof: keccak256(abi.encode(proofHash, hunter, bountyId)).
 * Must match BountyEscrow.commitmentOf. Binding the hunter and the bounty id means a copied
 * commitment can never be paid to the copier, nor replayed on another bounty.
 */
export function commitmentOf(proofHash, hunter, bountyId) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [proofHash, hunter, BigInt(bountyId)],
    ),
  );
}
