// End-to-end local demo (anvil only, nothing leaves this machine except a Telegraph request in
// live mode).
//
//   node scripts/demo.js                 full run: Break it (bogus proofs rejected), then the hunter
//                                        buys a Telegraph review, proves the bug and gets paid
//   node scripts/demo.js --break-only    only the Break it part
//   TELEGRAPH_MODE=live node scripts/demo.js   pay the real endpoint from the testnet wallet
//                                        (default: mock, because that wallet is unfunded)
//
// Writes evidence/demo-run.json (tx hashes, events, balances, verdict hashes, Telegraph record).
import fs from "node:fs";
import path from "node:path";
import { parseEther, formatEther, parseEventLogs } from "viem";
import {
  ROOT,
  startAnvil,
  forgeBuild,
  artifact,
  deploy,
  targetHash,
  invariantHash,
  INVARIANT,
} from "../lib/chain.js";
import { ESCROW_ABI } from "../lib/escrow-abi.js";
import { startMockServer } from "../mock/ask-server.js";
import { runHunter } from "../agent/hunter.js";
import { resolveSubmission } from "../verifier/resolver.js";
import { proofHashOf } from "../verifier/verify.js";

const breakOnly = process.argv.includes("--break-only");
const mode = process.env.TELEGRAPH_MODE === "live" ? "live" : "mock";
const log = (m) => console.log(m);

function events(rcpt) {
  return parseEventLogs({ abi: ESCROW_ABI, logs: rcpt.logs }).map((e) => ({
    event: e.eventName,
    args: Object.fromEntries(
      Object.entries(e.args).map(([k, v]) => [
        k,
        typeof v === "bigint" ? v.toString() : v,
      ]),
    ),
  }));
}

async function main() {
  log("== build");
  forgeBuild();
  const env = await startAnvil();
  const mock = mode === "mock" ? await startMockServer() : null;
  const [poster, verifier, hunter, bogusHunter] = env.accounts;
  const run = {
    at: new Date().toISOString(),
    telegraph_mode: mode,
    chain: "local anvil (chainid 31337)",
    invariant: INVARIANT,
  };
  try {
    log(`== deploy BountyEscrow (local anvil ${env.url})`);
    const escrow = (
      await deploy(env, poster, artifact("BountyEscrow.sol", "BountyEscrow"))
    ).address;
    run.escrow = escrow;

    log(
      "== poster locks 1 ETH for: target = VulnerableVault/PatchedVault sources, invariant = " +
        INVARIANT,
    );
    const block = await env.pub.getBlock();
    const postHash = await env.wallet.writeContract({
      account: poster,
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "post",
      args: [
        verifier,
        block.timestamp + 7n * 86400n,
        targetHash(),
        invariantHash(),
      ],
      value: parseEther("1"),
    });
    const postRcpt = await env.pub.waitForTransactionReceipt({
      hash: postHash,
    });
    const bountyId = 0n;
    run.post = { tx: postHash, events: events(postRcpt) };

    const verifierService = (proofSource) =>
      resolveSubmission({ env, escrow, bountyId, verifier, proofSource, log });

    log("== Break it: a second hunter submits bogus proofs");
    run.break_it = [];
    for (const file of [
      "proofs/bogus/NoopExploit.sol",
      "proofs/bogus/ForceFeedExploit.sol",
    ]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const proofHash = proofHashOf(source);
      const tx = await env.wallet.writeContract({
        account: bogusHunter,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "submit",
        args: [bountyId, proofHash],
      });
      await env.pub.waitForTransactionReceipt({ hash: tx });
      const res = await verifierService(source);
      const rcpt = await env.pub.getTransactionReceipt({ hash: res.resolveTx });
      run.break_it.push({ file, submit_tx: tx, ...res, events: events(rcpt) });
      if (res.valid) throw new Error(`BUG: bogus proof ${file} was accepted`);
    }
    const owedBogus = await env.pub.readContract({
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "owed",
      args: [bogusHunter],
    });
    log(
      `break it: both bogus proofs rejected on-chain; bogus hunter owed ${formatEther(owedBogus)} ETH`,
    );
    run.break_it_owed_wei = owedBogus.toString();
    if (breakOnly) return;

    log(
      `== hunter agent (${hunter}) hunts bounty #${bountyId}; Telegraph mode: ${mode}`,
    );
    const before = await env.pub.getBalance({ address: hunter });
    const result = await runHunter({
      env,
      escrow,
      bountyId,
      hunter,
      telegraph: { mode, endpoint: mock?.url, network: "base" },
      handToVerifier: verifierService,
      log,
    });
    if (!result.resolution?.valid)
      throw new Error("hunter did not produce a valid proof");
    const resolveRcpt = await env.pub.getTransactionReceipt({
      hash: result.resolution.resolveTx,
    });

    const wtx = await env.wallet.writeContract({
      account: hunter,
      address: escrow,
      abi: ESCROW_ABI,
      functionName: "withdraw",
    });
    const wrcpt = await env.pub.waitForTransactionReceipt({ hash: wtx });
    const after = await env.pub.getBalance({ address: hunter });
    const escrowBal = await env.pub.getBalance({ address: escrow });
    log(
      `hunter withdrew: balance delta ${formatEther(after - before)} ETH (1 ETH reward minus gas for submit+withdraw)`,
    );
    log(`escrow balance now ${formatEther(escrowBal)} ETH`);

    const p = result.purchase;
    run.hunt = {
      hunter,
      proof_file: result.proofFile,
      proof_hash: result.proofHash,
      submit_tx: result.submitTx,
      resolution: result.resolution,
      resolve_events: events(resolveRcpt),
      withdraw_tx: wtx,
      withdraw_events: events(wrcpt),
      hunter_balance_delta_wei: (after - before).toString(), // reward minus gas for submit + withdraw
      escrow_balance_after_wei: escrowBal.toString(),
      telegraph_purchase: {
        mode: p.mode,
        endpoint: p.endpoint,
        status: p.status,
        intent: p.request.intent,
        miner_id: p.miner_id,
        cost_usd: p.cost_usd,
        signal_hash: p.signal_hash,
        receipt: p.receipt,
        payment: p.payment,
        payment_required_error: p.payment_required_error,
        ledger: "evidence/telegraph-receipts.ndjson",
      },
    };
  } finally {
    fs.mkdirSync(path.join(ROOT, "evidence"), { recursive: true });
    const out = path.join(
      ROOT,
      "evidence",
      breakOnly ? "break-run.json" : "demo-run.json",
    );
    fs.writeFileSync(out, JSON.stringify(run, null, 2) + "\n");
    log(`== evidence written to ${path.relative(ROOT, out)}`);
    await mock?.close();
    await env.stop();
  }
}

main().catch((e) => {
  console.error(`demo failed: ${e.message}`);
  process.exit(1);
});
