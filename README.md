# telegraph-bounty

A bug bounty paid to the machine that proved the bug.
Entry for Telegraph Hackathon Season II, Apps & Agents track, mission "Web3 Native and DeFi".

A poster locks a reward in `BountyEscrow` for a target (a hash of the vulnerable and the patched
source) and a stated invariant. A hunter agent buys a security review from Telegraph over x402,
writes or picks a proof, commits the proof's hash on-chain, and hands the proof to the bounty's
verifier. The verifier decides with a deterministic forge build plus anvil run. No model opinion
is involved. A proof is valid only if it breaks the invariant on the vulnerable code and does not
break it on the patched code. A valid proof credits the reward to the address that committed it.

Scope: every contract tested here is written in this repo. `VulnerableVault` is deliberately
vulnerable and exists only as a demo bounty target. Nothing here targets third-party or deployed
contracts, and nothing has been deployed to any chain.

## Status (2026-11-23)

| Item | State |
|---|---|
| Contracts, forge tests (unit, fuzz, invariant) | done, 23/23 pass |
| Deterministic verifier and JS tests | done, 9/9 pass |
| End-to-end local demo (escrow on anvil, payout, Break it) | done |
| Real paid Telegraph request | **done 2026-11-23**: `SECURITY_REVIEW_GENERAL`, $0.01 test USDC on Base Sepolia, settled on-chain in tx `0x670f7fe100f43f9f572a68d02e0664005f71399f35e81fb9cbce445a8bae7423` (status 1, block 62835685). Recorded in `evidence/telegraph-receipts.ndjson` (`mode:"live"`). |
| Telegraph purchase in the demo | **live** with `TELEGRAPH_MODE=live` (real endpoint, real payment); the default `npm run demo` still uses the local mock so it runs without funds |
| Ultrafuzz campaign | **not run**. It is a hard gate before any deploy |
| Deploy | none, by design. The code stops at "ready to deploy" |

## Layout

```
src/VulnerableVault.sol   demo target, re-entrancy bug in withdrawAll() (never deploy)
src/PatchedVault.sol      the fix (checks-effects-interactions)
src/BountyEscrow.sol      post / submit(proofHash) / resolve / reclaim / withdraw (pull payments)
proofs/ReentrancyExploit.sol      valid proof
proofs/bogus/*.sol                Break-it proofs that must be rejected
verifier/verify.js        the deterministic verifier
verifier/resolver.js      verifier service: checks the on-chain commit, verifies, calls resolve()
verifier/cli.js           npm run verify -- <proof.sol>
agent/hunter.js           hunter agent: Telegraph purchase, ranks templates, self-check, commit, hand off
lib/telegraph.js          x402 client (same stack as the reference ask.js) with spend guards and an append-only ledger
mock/ask-server.js        local stand-in for /engine/v1/ask (replays mock/recorded-402.json)
scripts/demo.js           end-to-end run on local anvil
evidence/                 ledger, verdicts, demo-run.json, break-run.json, intents snapshot
```

## Run it

Requirements: Foundry (`forge`, `anvil` in `~/.foundry/bin` or `FORGE`/`ANVIL` env vars), Node 24.

```bash
git submodule update --init      # forge-std
npm install
npm run demo                     # Break it, then hunt, verify, pay, withdraw (Telegraph mock)
```

The demo starts a private anvil, deploys `BountyEscrow`, and has the poster lock 1 ETH. Then:

1. Break it. A second hunter commits two bogus proofs. The verifier rejects both on-chain
   (`Rejected` events) and the bogus hunter is owed 0.
2. The hunter agent buys `SECURITY_REVIEW_GENERAL`, ranks its templates from the answer, and
   self-checks the proof. It commits the proof hash, and the verifier resolves it as valid (`Paid`).
   The hunter then withdraws 1 ETH (minus gas).

Live mode pays the real endpoint from the testnet-only wallet. It needs test USDC first:

```bash
TELEGRAPH_MODE=live npm run demo
```

## Check it

```bash
npm test                 # forge test (23) + node --test (9)
npm run verify -- proofs/ReentrancyExploit.sol      # exit 0, valid
npm run verify -- proofs/bogus/NoopExploit.sol      # exit 1, rejected
```

The verifier's rule (`verifier/verify.js`):

1. Static checks: at most 32 KB, no `import`, and it must define `contract Exploit`.
2. The proof is compiled alone in a throwaway sandbox with `forge build --offline`. The ABI must be
   `constructor(address vault) payable` and `run()`.
3. For each target, a fresh anvil starts at a fixed genesis timestamp. The verifier deploys the
   target, seeds three honest deposits (3, 3 and 4 ETH), and deploys `Exploit` with 1 ETH from a
   separate attacker account. It then calls `run()` once. Gas is pinned to 5,000,000 and reverts
   are recorded.
4. Invariant: `address(vault).balance >= vault.totalDeposits()` (solvency).
5. The proof is VALID only if the invariant is broken on vulnerable AND holds on patched.

The verdict JSON is hashed canonically (`verdict_hash`), and the same proof always produces the same
hash. A JS test checks this. That hash is what `resolve()` records on-chain.

Design notes (why it is strict):

- Proofs run on anvil, not inside `forge test`. In a forge test any contract can call Foundry
  cheatcodes (`vm.store`, `vm.deal`), so a "proof" could just rewrite the vault's storage.
- The invariant uses solvency rather than equality. Ether can be force-fed into any contract with
  `selfdestruct`. With equality, a proof could check which target it is running against and
  force-feed only the vulnerable one, and that would pass the vulnerable-breaks / patched-holds
  check without exploiting anything. Force-feeding only raises the balance, so it cannot fake
  insolvency. `proofs/bogus/ForceFeedExploit.sol` shows this, and so does
  `test_forceFeed_cannotFakeInsolvency`.
- `BountyEscrow` binds the payout to the first address that committed the proof hash. Only the
  hash goes on-chain, so committing does not leak the exploit.

## Inspect it

- `evidence/telegraph-receipts.ndjson` is the append-only ledger of every Telegraph attempt: mode,
  endpoint, payer, network, status, request, signed amount, payTo, response, miner_id, cost_usd,
  signal_hash, the decoded `PAYMENT-RESPONSE`, `X-TELEGRAPH-RECEIPT`, and the rejection reason on a
  402. Live rows are the real endpoint. Mock rows say `"mode":"mock"` and carry `mock-receipt-…`.
- `evidence/demo-run.json` holds escrow tx hashes, decoded events (`Posted`, `Submitted`,
  `Rejected`, `Paid`, `Withdrawn`), balances, and the Telegraph purchase record.
- `evidence/verdicts/<proofHash>.json` holds the full verdict for each proof the verifier resolved.
- `evidence/intents-snapshot.ndjson` holds the miner counts per intent (captured 2026-11-12).
- `mock/recorded-402.json` is the real 402 challenge captured from the endpoint.

## Break it

```bash
npm run break     # only the bogus-proof part of the demo
```

| Bogus proof | What it does | Why it is rejected |
|---|---|---|
| `NoopExploit.sol` | honest deposit and withdraw | invariant holds on vulnerable |
| `ForceFeedExploit.sol` | `selfdestruct` ether into the vault | only raises the balance, so solvency still holds |
| any file with `import` | e.g. pulls in forge-std `Vm` | static stage |
| wrong ABI or no compile | | compile stage |
| reverting constructor | | recorded as `deploy_status: reverted`, rejected |

On-chain checks (forge tests):

- only the verifier can resolve
- no payout without a commit
- the same proof hash cannot be committed twice (no copying a hunter's hash)
- a bounty pays at most once
- no submissions after the deadline
- the poster reclaims only after `deadline + 1 day`, which also closes `resolve`
- a hunter whose receive() reverts cannot block others

## Reproduce it

Everything runs locally and deterministically. These commands rebuild everything:

```bash
forge build && forge test && node --test test-js/*.test.js && npm run demo
```

Verdict hashes depend only on the proof source, the two target sources, and the pinned scenario.
The escrow tx hashes in `demo-run.json` come from a fresh anvil with fixed dev accounts.

## Telegraph usage

- The purchase is `SECURITY_REVIEW_GENERAL` with `{"target": "<≤256-byte minified withdrawAll() of OUR demo vault>"}`.
  The answer only orders the hunter's exploit templates. It never decides a payout.
- Spend guards for live mode:
  - x402 `spendControls` cap of `$0.02` per payment
  - a policy that allows only the `exact` scheme with test USDC on the chosen testnet and amount ≤ 20000 atomic
  - a ledger check that refuses a request once conservative live spend + $0.02 would exceed $0.30.
    Every signed live payment counts as spent, even a rejected one.
- Miner counts on 2026-11-12 (`GET /engine/v1/intents/<NAME>`): the base names have 0 miners.
  The `_GENERAL` children have miners:

  | Intent | Miners |
  |---|---|
  | `SECURITY_REVIEW_GENERAL` | 32 |
  | `VULNERABILITY_TRIAGE_GENERAL` | 37 (takes a `cve_id`, so it does not fit an unpublished bug) |
  | `CODE_PATCH_VERIFY_GENERAL` | 24 (takes a repo/commit link, so it needs a public repo) |
  | `REGRESSION_VERIFY_GENERAL` | 20 |
  | `SMART_CONTRACT_AUDIT_GENERAL` | 17 (no request schema) |
  | `CODE_REVIEW_GENERAL` | 17 |

  Many listed miners look like generic data-source adapters. Answer quality is unverified until a
  paid request succeeds.

### What the mock is

`mock/ask-server.js` replays the real 402 challenge recorded from the live endpoint. The hunter pays
it with the real `@x402/fetch` client. The mock then checks the payment the way a facilitator's
verify step would:

- x402 v2
- the accepted requirement is one that was offered
- payTo and amount match
- the validity window is current
- the EIP-3009 `TransferWithAuthorization` signature recovers to `from`

It settles nothing. It returns a canned `SECURITY_REVIEW` answer marked `mock: true`. In mock mode
the payer is an in-memory throwaway key that never holds funds. The real testnet wallet is used only
in live mode, its key is read from `~/.empowertours/telegraph-sepolia.json`, and it is never printed.

## Remaining before deploy / submission

1. Fund the testnet wallet with test USDC and run `TELEGRAPH_MODE=live npm run demo`. That records a
   real receipt (`miner_id`, `signal_hash`, `X-TELEGRAPH-RECEIPT`, `PAYMENT-RESPONSE`). The
   hackathon requires at least one real machine-to-machine purchase.
2. Run an Ultrafuzz campaign on `BountyEscrow` and triage its findings. This is a hard gate before
   any deploy. `VulnerableVault` is a demo target and must never be deployed with funds.
3. Optional, per the mission page ("bounty payout simulated on Sepolia"): deploy `BountyEscrow` to a
   testnet after step 2.
4. Record the 2-5 min demo video and fill in the submission.

Known limits (for mainnet readiness):

- The verifier is a single key chosen by the poster. It is trusted to run the public deterministic
  check honestly, and anyone can re-run it and compare `verdict_hash`.
- The proof is handed to the verifier off-chain.
- The reward is native ETH only.
