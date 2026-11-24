Reference exploits, one per held-out target. Tests use them to prove each target is
exploitable under the verifier's scenario and that each patch closes the hole.
The hunter agent must never read this directory; test-js/real-hunter.test.js enforces it.

lend-pool and hook-vault (added after the first live runs) need multi-step exploits:
- LendPoolExploit: move the exchange's spot price, post the bought GOV as collateral, borrow
  against the inflated value (three calls in one transaction).
- HookVaultExploit: cross-function re-entrancy from the token's transfer hook into the
  unguarded transfer(), repeated, then a second contract withdraws the free credit.
