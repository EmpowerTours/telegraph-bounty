# telegraph-bounty

A bug bounty paid to the machine that proved the bug.
Entry for Telegraph Hackathon Season II, Apps & Agents track, mission "Web3 Native and DeFi".

A poster locks a reward in `BountyEscrow` for a target (a hash of the vulnerable and the patched
source) and a stated invariant. A hunter agent buys a security review from Telegraph over x402,
writes or picks a proof, commits `keccak256(abi.encode(proofHash, hunter, bountyId))` on-chain, and
hands the proof plus its own address to the bounty's verifier. The verifier decides with a deterministic forge build plus anvil run. No model opinion
is involved. A proof is valid only if it breaks the invariant on the vulnerable code and does not
break it on the patched code. A valid proof credits the reward to the address that committed it;
a copy of someone else's commitment can never be paid (see "Security fixes after Ultrafuzz").

Scope: every contract tested here is written in this repo. `VulnerableVault` is deliberately
vulnerable and exists only as a demo bounty target. Nothing here targets third-party or deployed
contracts, and nothing has been deployed to any chain.

## Status (2026-11-26)

| Item | State |
|---|---|
| Contracts, forge tests (unit, fuzz, invariant) | done, 39/39 pass (after the Ultrafuzz fixes, 2026-11-24) |
| Deterministic verifier and JS tests | done, 45/45 pass |
| End-to-end local demo (escrow on anvil, payout, Break it) | done |
| Real paid Telegraph request | **done 2026-11-23**: `SECURITY_REVIEW_GENERAL`, $0.01 test USDC on Base Sepolia, settled on-chain in tx `0x670f7fe100f43f9f572a68d02e0664005f71399f35e81fb9cbce445a8bae7423` (status 1, block 62835685). Recorded in `evidence/telegraph-receipts.ndjson` (`mode:"live"`). |
| Telegraph purchase in the demo | **live** with `TELEGRAPH_MODE=live` (real endpoint, real payment); the default `npm run demo` still uses the local mock so it runs without funds |
| Real hunter on 5 held-out targets (mission 14) | **done**, live: 3/3 solved in two runs (2026-11-24), then 5/5 in each of three 5-target runs (2026-11-24, 11-25, 11-26), all but one on the first model attempt. See "Real hunter" below |
| Ultrafuzz campaign | **run 2026-11-24** (bounty-002): 1 High, 1 Medium, 2 Low, all fixed. **Re-run 2026-11-25** (bounty-003) on the fixed commit: no Critical, High or Medium; its 2 Lows (deploy script) fixed. See `audit/ultrafuzz-bounty-003.md` |
| Deploy | **Monad testnet (chain 10143), 2026-11-25**: BountyEscrow `0x36dc4b67d1875D7c47ddb6fa29122219DC471Fec`, demo targets VulnerableVault `0xb663397b926E49DBA9283EAff0940b37eccfDdfd` and PatchedVault `0x55E0cED018F066a4e928B15893804a90FA68538d` (`deployments/monad-testnet.json`; on-chain bytecode matches the build). Live hunts still settle on a local anvil chain |

## Layout

```
src/VulnerableVault.sol   demo target, re-entrancy bug in withdrawAll() (never deploy)
src/PatchedVault.sol      the fix (checks-effects-interactions)
src/BountyEscrow.sol      post / submit(commitment) / resolve(proofHash, hunter) / reclaim / withdraw (pull payments)
proofs/ReentrancyExploit.sol      valid proof
proofs/bogus/*.sol                Break-it proofs that must be rejected
verifier/verify.js        the deterministic verifier
verifier/resolver.js      verifier service: checks the hunter's own on-chain commitment, verifies, calls resolve()
verifier/cli.js           npm run verify -- <proof.sol>
agent/hunter.js           template hunter (original demo): Telegraph purchase, ranks templates, self-check, commit
agent/real-hunter.js      real hunter: Telegraph findings, LLM-written exploit, verifier self-check loop, commit
lib/llm.js                model backends (Anthropic SDK / headless Claude CLI / replay) and spend guards
targets/<id>/             held-out targets: vulnerable + patched source, target.js (invariant + scenario)
targets/_reference/       one reference exploit per target, for tests only (the hunter never reads it)
targets/test/             forge tests for the targets (FOUNDRY_PROFILE=targets)
verifier/verify-target.js the deterministic verifier for the held-out targets
scripts/demo-hunt.js      npm run demo:hunt
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

### Run it with your own keys (live mode)

Offline demos (`npm run demo`, `npm run demo:hunt`) need no keys. Live mode makes real x402
purchases on Telegraph and real model calls, paid by **you**:

1. **Testnet wallet with test USDC.** Create a fresh wallet used only for this, and get free test
   USDC on Base Sepolia from Circle's faucet (https://faucet.circle.com, pick Base Sepolia). The x402
   payment is gasless for the payer, so no Base Sepolia ETH is needed. Each Telegraph purchase costs
   $0.01; a full 5-target hunt makes 15 purchases ($0.15). Then give the hunter the key, either way:
   ```bash
   export TELEGRAPH_PRIVATE_KEY=0x...        # testnet-only key
   # or
   export TELEGRAPH_WALLET_FILE=/path/to/wallet.json   # {"private_key": "0x..."}
   ```
2. **The model, on your own Claude account.** Pick one:
   - **Your Claude login (no API key).** Install Claude Code (https://claude.com/claude-code), run
     `claude` once and log in. The hunter then calls `claude -p` headlessly, so model usage comes out
     of your own Claude plan. Leave `ANTHROPIC_API_KEY` unset. A hard cap of 12 model calls per run applies.
   - **An Anthropic API key.** `export ANTHROPIC_API_KEY=sk-ant-...` (about $0.02 to $0.04 per target
     with `claude-sonnet-5-5`; hard cap of USD 3 per run, failing closed).
3. Run:
   ```bash
   TELEGRAPH_MODE=live npm run demo:hunt
   ```
   Purchases are appended to `evidence/telegraph-receipts.ndjson`. The ledger refuses new live
   purchases once its recorded live total reaches $1.50, so for a large run start from a fresh ledger.

Never use a wallet that holds real funds. Keys are read from the environment or the file and are
never printed or logged.

The demo starts a private anvil, deploys `BountyEscrow`, and has the poster lock 1 ETH. Then:

1. Break it. A second hunter commits two bogus proofs. The verifier rejects both on-chain
   (`Rejected` events, stored as a final verdict) and the bogus hunter is owed 0.
2. The hunter agent buys `SECURITY_REVIEW_GENERAL`, ranks its templates from the answer, and
   self-checks the proof. It commits `keccak256(abi.encode(proofHash, hunter, bountyId))` and hands
   the proof and its address to the verifier.
3. Break it, part 2. Before the verifier runs, the second hunter replays the hunter's commitment
   from the chain. The verifier service refuses to pay the copier, and so does the contract
   (`NotSubmitted`). The verifier resolves the hunter's proof as valid (`Paid`), and the hunter
   withdraws 1 ETH (minus gas). A recorded run is in `evidence/demo-run-mock-after-fix.json`.

Live mode pays the real endpoint from the testnet-only wallet. It needs test USDC first:

```bash
TELEGRAPH_MODE=live npm run demo
```

## Check it

```bash
npm test                 # forge test (39) + targets profile forge test (15) + node --test (45)
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
- `BountyEscrow` pays only the address that itself committed
  `keccak256(abi.encode(proofHash, hunter, bountyId))`. Only the commitment goes on-chain, so
  committing leaks neither the exploit nor its hash; the proof hash is revealed at `resolve()`.

## Inspect it

- `evidence/telegraph-receipts.ndjson` is the append-only ledger of every Telegraph attempt: mode,
  endpoint, payer, network, status, request, signed amount, payTo, response, miner_id, cost_usd,
  signal_hash, the decoded `PAYMENT-RESPONSE`, `X-TELEGRAPH-RECEIPT`, and the rejection reason on a
  402. Live rows are the real endpoint. Mock rows say `"mode":"mock"` and carry `mock-receipt-…`.
- `evidence/demo-run.json` holds escrow tx hashes, decoded events (`Posted`, `Submitted`,
  `Rejected`, `Paid`, `Withdrawn`), balances, and the Telegraph purchase record. It is the live run
  from 2026-11-23, made with the escrow as it was before the Ultrafuzz fixes (`submit(proofHash)`).
  `evidence/demo-run-mock-after-fix.json` is a mock-mode run of the fixed escrow, including the
  copier step. The recorded `evidence/hunt/live-*` runs also predate the fix.
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
- no payout without a commit by the paid hunter itself
- a copied commitment is never payable to the copier and does not block the hunter
  (`test_frontRun_legacyPaysTheCopier` shows the old contract paying the copier;
  `test_frontRun_fixedRefusesTheCopier` shows the fix refusing it)
- a commitment cannot be replayed on another bounty
- each commitment gets one stored verdict: no re-rejecting, no flipping Rejected to Paid
- the poster cannot be the bounty's verifier
- a bounty pays at most once
- no submissions after the deadline
- the poster reclaims only after `deadline + 1 day`, which also closes `resolve`
- a hunter whose receive() reverts cannot block others

## Security fixes after Ultrafuzz

The Ultrafuzz campaign of 2026-11-24 (bounty-002) reported four distinct findings on
`BountyEscrow` and the deploy gate. Several stages reported each one; they are deduplicated here.

| # | Severity | Finding | Fix | Tests |
|---|---|---|---|---|
| 1 | High | `submit(id, proofHash)` recorded the first sender of a proof hash, and the hash is public in the mempool. A copier front-runs it and is paid when the verifier approves the real hunter's proof. Once confirmed, the same hash could also be replayed on another bounty for the same target. | The hunter commits `keccak256(abi.encode(proofHash, hunter, id))`. It is stored under the sender's own address (`commits[id][commitment][sender]`). `resolve(id, proofHash, hunter, valid, verdictHash)` recomputes the commitment and requires that `hunter` itself committed it. A copy lands under the copier's address, which is not in the commitment, so it never matches. It also does not block the hunter's own commit. The bounty id is in the commitment, so it cannot be replayed on another bounty. | `test_frontRun_legacyPaysTheCopier` (old contract, kept test-only in `test/legacy/`: copier owed 1 ETH, hunter 0), `test_frontRun_fixedRefusesTheCopier` (fixed: hunter 1 ETH, copier 0), `test_frontRun_copyAloneIsNeverPayable`, `test_crossBountyReplay_refused`, `testFuzz_onlyCommittingHunterCanBePaid`, `invariant_onlyCommittingHunterPaid`, and `test-js/escrow-commit.test.js` on anvil |
| 2 | Medium | The poster could name itself as verifier and decide instantly. | `post` reverts with `VerifierIsPoster`. No challenge window was added (see below). | `test_posterCannotBeVerifier`, `testFuzz_posterCannotBeVerifier`, JS test |
| 3 | Low | `Rejected` wrote no state. A proof could be rejected repeatedly with conflicting verdicts, or rejected and later paid. | Each commitment stores one verdict (`None`, `Rejected`, `Paid`, readable with `verdictOf`). A resolved commitment reverts `AlreadyResolved`. `Paid` also settles the bounty, so it is final. | `test_rejectedIsStoredAndFinal`, `test_paidIsFinal`, `test_rejectedOneProof_otherProofStillPayable`, `invariant_commitmentResolvedAtMostOnce` |
| 4 | Low | The deploy gate took the first `audit/ultrafuzz-*.md` with `Triage: done` and never tied it to the code being deployed. | The gate checks every report. It needs `Triage: done` plus `Commit: <sha>` or `Source-tree: <git tree hash of src/>`, and that commit's `src/` tree must equal HEAD's. It also refuses uncommitted changes in `src/`, `lib/forge-std`, `foundry.toml` and `foundry.lock`. It states that `VulnerableVault` is deployed on purpose as the deliberately vulnerable demo target. | `script/deploy-monad-testnet.sh --check` |

The invariant campaign adds an attacker actor that copies every honest commitment, on the same
bounty and on others. The invariants are: the attacker is never owed anything, no resolve is
accepted for a key its hunter did not commit, each commitment is resolved at most once, and wei is
conserved (`invariant_conservation`, `invariant_solvency`). Two mutants were checked against the
suite: a commitment that leaves the hunter out, and a `resolve` that drops the one-verdict check.
The invariant suite and the unit tests catch both.

**No challenge window, on purpose.** A window before `Paid` becomes withdrawable only helps if
someone can act during it, and this contract has no arbiter or dispute path. The verifier is the
only oracle, and with finding 3 a `Paid` verdict is final, so nothing could reverse a payout
during the window. A window would delay every honest payout and would not stop a poster who runs
the verifier from a second address. The remaining defence against a dishonest verifier is
off-chain: the check is public and deterministic, so anyone can re-run it and compare
`verdictHash`. Each commitment's `committedAt` is stored, so it is visible on-chain when an earlier
honest commitment was passed over. Making this enforceable would take a real dispute mechanism
(several verifiers, or a bonded challenger), which is out of scope here. The demo flow is
unchanged: resolving right after the commit still pays.

Residual, by design: the commitment protects the proof before `resolve()`. Once a proof body is
published (for example in `evidence/`), anyone holding it can make an honest commitment of their
own on another open bounty for the same target. The verifier should pay the earliest commitment,
which it can read from `commits(...).committedAt`.

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
in live mode, its key comes from `TELEGRAPH_PRIVATE_KEY`, `TELEGRAPH_WALLET_FILE` or (on the authors' machine) `~/.empowertours/telegraph-sepolia.json`, and it is never printed.

## Real hunter (mission 14: autonomous bug bounty hunter)

`agent/hunter.js` only picks from pre-written exploit templates. `agent/real-hunter.js` hunts
five held-out targets it has no exploit for, and proves the bugs it finds with the same
deterministic rule as above.

```bash
npm run demo:hunt                         # offline: Telegraph mock + replay of the recorded live model outputs
TELEGRAPH_MODE=live npm run demo:hunt     # live Telegraph + a real model (API if ANTHROPIC_API_KEY, else local claude CLI)
LLM_BACKEND=api|cli|replay  TARGETS=init-vault,share-vault   # overrides
```

### Targets

| Target | Bug class | Stated invariant |
|---|---|---|
| `init-vault` | missing access control: the `initializer` modifier never sets its flag, so anyone can re-initialize, become owner, pause and sweep | `address(vault).balance >= vault.totalDeposits()` |
| `share-vault` | rounding / first-depositor share inflation (shares priced on the raw balance; patch: virtual shares, offset 1e9) | every honest user who deposits after the attacker redeems at least 99% of their deposit |
| `token-vault` | unchecked return: `deposit()` ignores `transferFrom`'s `false` from a legacy token | `token.balanceOf(vault) >= vault.totalDeposits()` |
| `lend-pool` (added later, multi-step) | oracle manipulation: GOV collateral is valued at the built-in exchange's spot reserve ratio. Buy GOV to move the price, post it as collateral, borrow against the inflated value, all in one transaction. The attacker gets 10 ETH of capital, standing in for a flash loan. Patch: a fixed oracle price | `totalCollateral * 0.001 ether / 1e18 >= totalDebt` (debt fully backed at the launch price) |
| `hook-vault` (added later, multi-step) | cross-function re-entrancy through a token hook: `withdraw()` is `nonReentrant` but caches the balance, pushes tokens (the token calls `onTokenReceived` on the receiver) and writes the cached value back afterwards. `transfer()` is unguarded. The attack re-enters `transfer()` from the hook, repeats, and withdraws the free credit from a second contract. Patch: effects before the push, guard on `transfer()` | every honest depositor can withdraw and ends with at least what they deposited |

Each target is `targets/<id>/` with the vulnerable source, the patched source and `target.js`
(invariant plus scenario: deploy, honest setup, attack, honest follow-up, check). The vulnerable
sources say that a bug exists but not where. The target hash binds all three files, so a bounty
commits to the exact scenario.

`lend-pool` and `hook-vault` were added after the first two live runs, because the first three
targets were all solved on attempt 1. Their design (bug, invariant, scenario, attack capital) was
fixed and committed (`da7a24b`) before the hunter ever ran on them, and nothing was tuned after.
Each has to fit the 2000-character review limit after compaction, so both are single files. The proof shape is the same as for the demo vault:
`contract Exploit { constructor(address) payable; run() }`. One reference exploit per target lives in
`targets/_reference/`. Tests use it to show that each target is exploitable and that each patch holds.
The hunter reads target files only through `targets/index.js`, which refuses `_`-prefixed
directories. Three tests enforce the rule: a static check, a loader check, and a runtime fs spy
over a full mocked hunt that also checks the prompts.

### How the hunter works

1. **Intent check (free).** `GET /engine/v1/intents/<NAME>` for each intent. An intent is used only
   if it is `active` and has miners. The snapshot goes to `evidence/hunt/intents-latest.json`.
2. **Telegraph purchases** through the existing x402 client and ledger: Base Sepolia test USDC,
   $0.01 each, $0.02 per-payment cap, and a $1.50 ledger cap (raised from $0.30).
   - `SECURITY_REVIEW_GENERAL` gets the vulnerable source, compacted to fit the router's
     2000-character parameter limit.
   - `VULNERABILITY_TRIAGE_GENERAL` ranks each candidate issue. Its only parameter is `cve_id`,
     and these findings have no CVE, so the candidate description goes in that field.
   - After a proof self-checks, `CODE_PATCH_VERIFY_GENERAL` gets the vulnerable-to-patched diff.
     This purchase is informational only.

   An answer that the router produced with its last-resort general model is recorded but never
   used as a finding.
3. **Exploit writing.** The model gets the vulnerable source, the invariant, the scenario and the
   purchased findings (marked untrusted). It never gets the patched source. It writes a proof, and
   the hunter self-checks it with `verifier/verify-target.js` (forge plus fresh anvil chains). On a
   failure, the verdict goes back to the model: stage, reason, up to 40 lines of forge output, and
   the observed state on both sides. There are up to 4 attempts, `claude-sonnet-5-5` x3, then
   `claude-opus-5-5` for the last one. Every attempt is logged to
   `evidence/hunt/<run>/<target>/attempt-N.{json,prompt.txt,response.txt,sol}`. The JSON holds the
   prompt sha256, the model, usage, the cost and the forge result.
4. Only a self-checked valid proof is committed on the local-anvil `BountyEscrow`, as a commitment
   bound to the hunter and the bounty. The verifier service checks that commitment, re-runs the
   check and calls `resolve(id, proofHash, hunter, ...)`.

**Spend guards** (`lib/llm.js`):

- **API mode:** a USD 3 cap per run, computed from the reported usage at list price. Before each
  call, the worst case (an input upper bound plus `max_tokens` of output) is reserved. A call that
  could pass the cap is refused. An unknown model price, missing usage, or a response from a
  different model fails closed.
- **CLI mode:** a hard cap of 12 model calls per run. Every spawn counts, including failed ones.
  The CLI runs as `claude -p --model <m> --output-format json --max-turns 1 --tools "" --strict-mcp-config --setting-sources ""`,
  with the prompt on stdin, from an empty temp directory, and with a 420 s timeout.

### Telegraph intents (checked live 2026-11-24)

| Intent | Miners | Used? | What actually answered |
|---|---|---|---|
| `SMART_CONTRACT_AUDIT_GENERAL` | 20 | **skipped** | The intent is `registered`, not `active` (it has no input or output schema). Two probes ($0.02) were answered by the router's last-resort general model, not a miner |
| `SECURITY_REVIEW_GENERAL` | 37 | yes | Salence (miner 905227) on 11-24; VulnRank (miner 7310099) on 11-26. Parameters over 2000 characters are rejected and fall to the last-resort model |
| `VULNERABILITY_TRIAGE_GENERAL` | 41 | yes | ChainSight. It returns only `cvss_base_score`. A `vulnerability` parameter is rejected; only `cve_id` is accepted |
| `CODE_PATCH_VERIFY_GENERAL` | 25 | yes | Judge0 CE (a compile-and-run sandbox) on 11-24: it always returned `conclusion: failure` for Solidity, so it is uninformative. Telegraph Verity Intelligence on 11-26. The LLM patch-verify miner (CodeWire) was never selected by the router |

### Measured results (live, Telegraph live + local Claude CLI)

| Run | Telegraph | init-vault | share-vault | token-vault | lend-pool | hook-vault | Model calls | Model cost (CLI-reported) | Telegraph spend |
|---|---|---|---|---|---|---|---|---|---|
| `live-2026-11-24T03-31-07-896Z` | every review was over 2000 characters, so last-resort answers only: **no findings reached the model** | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | (not yet added) | (not yet added) | 3 (sonnet) | $0.0535 | $0.06 |
| `live-2026-11-24T03-34-53-159Z` (after the 2000-character fix) | Salence said "no security defect" for all three (wrong); ChainSight scored that 2.0 to 2.3 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | (not yet added) | (not yet added) | 3 (sonnet) | $0.0571 | $0.09 |
| `live-2026-11-24T03-54-24-021Z` (5 targets) | Salence said "no security defect" for all five (wrong); ChainSight scored 0 to 2.3 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | 5 (sonnet) | $0.1072 | $0.15 |
| `live-2026-11-25T23-04-33-007Z` (5 targets) | Telegraph's payment facilitator was failing (`402 batch_send_failed:stale_pending_nonce`): no purchase settled and no finding reached the model | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, **attempt 2** (attempt 1 had no Solidity code block; the retry got that feedback) | 6 (sonnet) | $0.1459 | $0 settled |
| `live-2026-11-26T15-37-34-563Z` (5 targets) | VulnRank said "no security defect" for all five (wrong); ChainSight scored 0; all 15 purchases settled | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | solved, attempt 1 | 5 (sonnet) | $0.1101 | $0.15 |

Per target, third run (`evidence/hunt/live-2026-11-24T03-54-24-021Z/run.json`). Every row: 1
attempt, `claude-sonnet-5-5` only, Telegraph $0.03 (review + triage + patch-verify, $0.01 each), 1 ETH
paid on the local escrow.

| Target | Model cost | Telegraph review said | Verifier | Second opinion | Triage CVSS | Resolve tx (local anvil) |
|---|---|---|---|---|---|---|
| `hook-vault` | $0.0353 | no defect | bug proven (reentrancy) | **wrong** | 2 | `0x889a4fff…aad9` |
| `init-vault` | $0.0182 | no defect | bug proven (access-control) | **wrong** | 0 | `0x1e271855…1716` |
| `lend-pool` | $0.0229 | no defect | bug proven (oracle-manipulation) | **wrong** | 2.3 | `0x3d8a0d78…d8a7` |
| `share-vault` | $0.0135 | no defect | bug proven (share-inflation) | **wrong** | 2 | `0xf115e825…de85` |
| `token-vault` | $0.0174 | no defect | bug proven (unchecked-return) | **wrong** | 2 | `0x5e3cf6b3…43d3` |

The hunter withdrew 5 ETH (withdraw tx `0xb6ac39bc…b4e0`). On `lend-pool` the model's proof buys
GOV with all 10 ETH, posts it as collateral and borrows every lent ether. On `hook-vault` it
re-enters `transfer()` from `onTokenReceived` to credit a helper contract, repeats, then withdraws
the credit. Both are the intended bugs, written without the patched source or the reference exploit.

These are local anvil txs from a deterministic chain, so the same inputs reproduce the same hashes.
The Base Sepolia settlement tx of each purchase is in `run.json` and in the ledger. Total live
Telegraph spend for this work: $0.37 (7 probes, then 6, 9 and 15 purchases), all settled. Later
additions to the ledger (2026-11-25 to 11-26): the 11-25 run settled nothing (facilitator outage); the
11-26 run settled all 15 purchases ($0.15). Our facilitator probe sent a malformed request (`query`
instead of `params.target`), so once the facilitator recovered, 14 probe payments settled and got
`400 invalid_params` back ($0.14, not refunded: Telegraph's reply says the payment settled but was not
credited); one corrected probe got a 200 ($0.01). The ledger counts $0.70 of the $1.50 cap.

### What the paid Telegraph review was worth here

Each target's `run.json` entry has a `second_opinion` record (`agent/real-hunter.js`,
`secondOpinion()`): what the `SECURITY_REVIEW_GENERAL` miner said (defect or not, and which class,
by keyword), whether the deterministic verifier later proved a bug, and so whether the paid review
was right. Ground truth classes are in `targets/ground-truth.json`; they are used only for this
scoring and never reach a prompt (tested). `npm run demo:hunt` prints the line for each target.

In our runs, Telegraph's review missed every bug: 13 of 13 miner-answered reviews, from two different
miners (Salence in runs 2 and 3, VulnRank on 2026-11-26), said there was no security defect, and the
verifier proved one on every target. The triage miner
scored those "no defect" summaries 0 to 2.3 out of 10. The hunter still passes the findings to the
model, marked untrusted, but they did not contribute to any proof.

Payout does not depend on any of it. The escrow pays only when the deterministic verifier shows the
stated invariant broken on the vulnerable contract and holding on the patched one. That is the
point of the design: a review, from a Telegraph miner or from our own model, is an opinion, and an
opinion that was wrong 13 times out of 13 here moved no money. The verifier's check moved all of it.
This covers two miners (Salence, VulnRank) on one intent, on small single-file targets. It says nothing about
other miners or about larger codebases.

### Limitations

- **The targets are still known bug classes.** All five, including the two multi-step ones, were
  solved on the first attempt, except one retry on 2026-11-25 after a format error (no code block). So
  the live runs have exercised the feedback loop only for a format failure, never for a wrong exploit,
  and never the Opus fallback; unit tests with a mocked model cover those. Spot-price oracle manipulation and
  cross-function re-entrancy are well-documented exploit patterns, and each target is a single file
  under 2000 characters (compacted) that states its invariant and scenario. This shows that the
  pipeline works end to end on unseen code, including exploits that need a helper contract and
  several calls in one transaction. It does not show that the hunter finds bugs in large or
  unfamiliar codebases.
- **Telegraph did not help find these bugs.** In run 1, no finding reached the model. In runs 2 and
  3 and on 2026-11-26, the review miner reported no defect on all 13 targets reviewed, which was
  wrong each time.
  The model found the bugs from the source, the invariant and the scenario. The purchases are real,
  settled and ledgered, but today they are evidence of machine-to-machine payment, not of better
  hunting.
- **Each intent is used with workarounds:**
  - triage puts free text in `cve_id`;
  - the review gets compacted code (comments and events removed);
  - patch-verify routed to a sandbox that cannot compile Solidity.
- The scenario and invariant check are poster-written JS (`target.js`). It is bound by the target
  hash, but a verifier must trust that code, as it trusts the Solidity scenario of the demo vault.
- The reference exploits are committed in this repo. The model ran with no tools from an empty
  directory and saw only the prompt in `attempt-N.prompt.txt`, so it could not read them. The model
  output nevertheless matches the canonical attacks for these classes, as expected for known bugs.
- The two harder targets were written by the same agent setup that writes the hunter's prompts and
  reference exploits. They were committed before the hunter ran on them and not tuned afterwards,
  but they are not independently sourced.
- The offline `npm run demo:hunt` replays recorded model outputs (labelled `replay`). It calls no model.

## Deploy and submission status

1. Real machine-to-machine purchases: done (first on 2026-11-23; every live row is in
   `evidence/telegraph-receipts.ndjson`).
2. Ultrafuzz on the fixed commit: done (bounty-003, triaged). This stays a hard gate:
   `script/deploy-monad-testnet.sh` refuses unless an `audit/ultrafuzz-*.md` report says
   `Triage: done` and names a `Commit:` (or `Source-tree:`, i.e. `git rev-parse HEAD:src`) whose
   `src/` equals the `src/` being deployed (`--check` runs the gate alone). `VulnerableVault` is the
   deliberately vulnerable demo target; the script deploys it on purpose, to testnet only, and it
   must never be deployed with funds.
3. Testnet deploy: done on Monad testnet (see Status).
4. Demo video and submission: in progress.

Known limits (for mainnet readiness):

- The verifier is a single key chosen by the poster (it may not be the poster's own address, but a
  second address the poster controls is not detectable on-chain). It is trusted to run the public
  deterministic check honestly, and anyone can re-run it and compare `verdict_hash`.
- The proof is handed to the verifier off-chain.
- The reward is native ETH only.
