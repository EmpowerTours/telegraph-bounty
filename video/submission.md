# Telegraph Hackathon Season II: submission draft (Apps & Agents track)

Fill in the fields marked TODO at submission time. Every claim below is backed by a file in the repo.

## Project details
- **Project name:** telegraph-bounty: a bug bounty paid to the machine that proved the bug
- **Team / contact:** Earvin Gallardo (EmpowerTours), solo. TODO: contact email as registered on the H2 site
- **Track:** Apps & Agents
- **Mission:** 14 · Web3 Native and DeFi ("autonomous bug bounty hunter")
- **Intents used:** SECURITY_REVIEW_GENERAL, VULNERABILITY_TRIAGE_GENERAL, CODE_PATCH_VERIFY_GENERAL.
  SMART_CONTRACT_AUDIT_GENERAL was skipped: it is registered but not active; see the README.
- **Working link:** https://empowertours.github.io/telegraph-bounty/ (explorer of every recorded hunt);
  code: https://github.com/EmpowerTours/telegraph-bounty (offline demo needs no keys)
- **GitHub username that starred telegraphprotocol/bounties:** EmpowerTours
- **Network:** Telegraph payments in test USDC on Base Sepolia (x402). Escrow deployed on Monad testnet
  (chain 10143): BountyEscrow 0x36dc4b67d1875D7c47ddb6fa29122219DC471Fec, demo targets VulnerableVault
  0xb663397b926E49DBA9283EAff0940b37eccfDdfd and PatchedVault 0x55E0cED018F066a4e928B15893804a90FA68538d
  (commit 4095b83, `deployments/monad-testnet.json`). Live hunts settle on a local anvil chain.

## Short public summary (about 60 words)
An autonomous bug-bounty hunter. A poster locks a reward against a rule the code must never break.
The hunter agent buys security reviews over Telegraph, has Claude write an exploit, and gets paid only
if a deterministic Foundry verifier shows the exploit breaks the vulnerable code and fails on the
patched code. Money moves on proof, never on an AI's opinion.

## Commercial summary (the five questions)
1. **Who is it for?** Protocol teams that run bug bounties, and whitehat hunters and security firms
   that want to automate hunting on well-specified targets.
2. **What does it improve?** Bounty triage today is slow and trust-based: hunters wait weeks for a
   human to judge a report, and posters must trust whoever decides. Here, payout is decided by running
   the proof, so it is instant and checkable, and a hunter's proof can't be stolen (commit-reveal
   bound to the hunter).
3. **What does it do today?** On the hunter's own Claude account it:
   - buys Telegraph reviews, triage and patch checks;
   - writes an exploit for contracts it has never seen;
   - self-checks the exploit and retries;
   - gets paid by the escrow.

   It solved 5 of 5 held-out targets in each of three live runs (2026-11-24, 11-25, 11-26), including a spot-price lending pool and a callback
   re-entrancy. It costs about $0.15 of Telegraph calls and $0.02–0.04 of model calls per target.
4. **Why adopt it?**
   - The verifier is the product. The paid AI review was wrong on 13 of 13 targets in our runs, from
     two different review miners; the deterministic check never pays the wrong person.
   - The escrow was fuzzed with Ultrafuzz. A front-running bug it found is fixed and covered by tests.
   - It is open source and runs on the hunter's own keys, so the operator carries no model cost.
5. **How do I try it?** `git clone https://github.com/EmpowerTours/telegraph-bounty && cd telegraph-bounty
   && git submodule update --init && npm install && npm run demo:hunt`. That runs offline. For live
   mode, set `TELEGRAPH_PRIVATE_KEY` (testnet) and use your Claude login, then run
   `TELEGRAPH_MODE=live npm run demo:hunt`.

## How to run it
The README's "Run it" and "Run it with your own keys (live mode)" sections cover:
- prerequisites (Foundry, Node 24);
- configuration (environment variables);
- a sample run and the expected output;
- network (Base Sepolia for x402; local anvil for the escrow);
- costs and spending caps: Telegraph $1.50 ledger cap and $0.01 per call; model capped at 12 calls (CLI)
  or USD 3 (API) per run;
- known limitations.

## Evidence
- Real Telegraph purchases: `evidence/telegraph-receipts.ndjson` (live rows, settled on Base Sepolia).
  First live purchase tx 0x670f7fe1…7423.
- Live hunts: `evidence/hunt/live-2026-11-2*/run.json`, with per-target purchases, attempts, model
  calls, verdicts, resolve txs and the second-opinion-vs-ground-truth record. The 2026-11-26 run
  settled all 15 purchases on Base Sepolia (e.g. review tx 0x3a0ee28d…adda).
- Tests: forge 39 (including 6 invariants), targets profile 15, node 46.
- Security: Ultrafuzz bounty-002 findings and fixes (README "Security fixes after Ultrafuzz"),
  bounty-003 re-fuzz of the fixed escrow: clean, no Critical/High/Medium (`audit/ultrafuzz-bounty-003.md`);
  its two Lows in the deploy script are fixed.
- Demo video: TODO: link after upload.

## Original H2 updates (public)
- LinkedIn, 2026-11-24: "I paid an AI security reviewer 8 times…"
  https://www.linkedin.com/in/earvin-gallardo-a14b5989/recent-activity/all/ (TODO: exact post URL)
- TODO: 1–2 more posts before 1 Dec.

## Showcase permission
TODO: the user chooses on the H2 site.
