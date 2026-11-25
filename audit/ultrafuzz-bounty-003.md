# Ultrafuzz bounty-003: telegraph-bounty escrow fix

Commit: 5609469eb59fb8c6ba18d70f6ea283d8a1c4c236
Source-tree: 7ee64fdfaf057949d223ff87d230bc3e0cefee41
Triage: done

Run: bounty-003 on RunPod uf-nad7. The run started 2026-11-25 01:13 UTC and ended about 12:10 UTC with 201 stages. Profile: low-cost, claude-opus-5-5, effort high. The dedupe step completed. The run ended RunFailed at the post-dedupe lifecycle gate, the same known Ultrafuzz tooling bug seen on earlier runs. It is not a finding.

Scope: src/BountyEscrow.sol, src/PatchedVault.sol, src/VulnerableVault.sol (the intended vulnerable demo target), script/, test/, proofs/.

## Verdict

No Critical, High or Medium findings. All 2 raw and 2 deduped findings are Low or unrated. Both are in the off-chain deploy script, not in Solidity.

The bounty-002 High (the proof-hash commitment was not bound to the hunter, so it could be front-run) and its Mediums (a self-dealing verifier, and no recorded verdict) were not reported again against 5609469.

## Findings (hand-triaged against 5609469)

1. **Low, CONFIRMED.** script/deploy-monad-testnet.sh:37-41. The `Commit:` value is resolved with `git rev-parse "$c^{commit}:src"`. git reads an abbreviated SHA as a ref name first. Someone with repo write access could create a tag or branch named after the short SHA and point it at HEAD. A stale report would then pass the gate. Fix: accept only full 40-hex SHAs. Alternatively, use `git rev-parse --disambiguate`, and stop discarding git's stderr.
2. **Low, CONFIRMED.** script/deploy-monad-testnet.sh:47-48. `set -e` does not fire on the non-final member of `python3 ... && rm`. A failed manifest write therefore still prints "wrote deployments/monad-testnet.json" and exits 0. Because the JSON is built by string interpolation, a report path containing a quote or backslash would trigger the failure. Fix: `python3 ... || { echo "manifest write failed"; exit 1; }`, and build the JSON in Python from argv or environment variables.

VulnerableVault is the intended demo target, so its vulnerabilities are not counted as findings.

Findings JSON: ~/backups/ultrafuzz/findings-2026-11-25/bounty-003/workspaces/dedupe-findings/artifacts/dedupe-findings/deduped-findings.json
