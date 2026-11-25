#!/usr/bin/env bash
# Deploys BountyEscrow + the two demo vaults to Monad TESTNET (chain 10143).
#
# Gate (standing rule: every contract gets an Ultrafuzz campaign before any deploy). Refuses
# unless audit/ holds an Ultrafuzz report that
#   - has a line "Triage: done", and
#   - names what it audited with a line "Commit: <git sha>" and/or "Source-tree: <hash>",
#     where Source-tree is `git rev-parse <commit>:src` (the git tree hash of src/), and
#   - that commit's src/ tree (or the Source-tree hash) equals HEAD's src/ tree exactly.
# Every audit/ultrafuzz-*.md is checked; a stale report for older sources approves nothing.
# Also refuses if src/, lib/forge-std, foundry.toml or foundry.lock have uncommitted changes, since
# those decide the bytecode.
#
# VulnerableVault is DELIBERATELY vulnerable (re-entrancy drain): it is the demo target that
# bounty hunters prove the bug against, and it is deployed on purpose, to TESTNET only, holding
# no value beyond what demo users deposit. The Ultrafuzz report is expected to list it as a known,
# accepted finding. Never deploy it to a mainnet.
#
#   script/deploy-monad-testnet.sh --check   run the gate only (no network, no key, no deploy)
#
# Key: the testnet-only wallet in ~/.empowertours/telegraph-sepolia.json, read at run time, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain -- src lib/forge-std foundry.toml foundry.lock)" ] ||
  { echo "refusing: src/, lib/forge-std, foundry.toml or foundry.lock has uncommitted changes"; exit 1; }
HEAD_SRC=$(git rev-parse HEAD:src)

REPORT=""
for r in audit/ultrafuzz-*.md; do
  [ -f "$r" ] || continue
  grep -q "^Triage: done" "$r" || { echo "skip $r: no 'Triage: done' line"; continue; }
  matched=""
  while read -r tree; do
    [ "$tree" = "$HEAD_SRC" ] && matched="Source-tree $tree"
  done < <(sed -n 's/^Source-tree: *\([0-9a-f]\{40\}\).*/\1/p' "$r")
  while read -r c; do
    [ -n "$c" ] || continue
    t=$(git rev-parse --verify --quiet "$c^{commit}:src" 2>/dev/null || true)
    [ -n "$t" ] && [ "$t" = "$HEAD_SRC" ] && matched="Commit $c (src tree $t)"
  done < <(sed -n 's/^Commit: *\([0-9a-f]\{7,40\}\).*/\1/p' "$r")
  if [ -n "$matched" ]; then REPORT=$r; echo "gate: $r audited $matched == HEAD src tree"; break; fi
  echo "skip $r: names no Commit/Source-tree whose src/ equals HEAD's src/ ($HEAD_SRC)"
done
[ -n "$REPORT" ] || {
  echo "refusing: no triaged Ultrafuzz report in audit/ for HEAD's src/ (tree $HEAD_SRC)."
  echo "  The report needs 'Triage: done' and 'Commit: <sha>' or 'Source-tree: $HEAD_SRC'."
  exit 1
}
echo "gate: NOTE VulnerableVault is deployed on purpose as the deliberately vulnerable demo target (testnet only)."
[ "${1:-}" = "--check" ] && { echo "gate: ok (--check, nothing deployed)"; exit 0; }

RPC=${RPC:-https://testnet-rpc.monad.xyz}
[ "$(cast chain-id --rpc-url "$RPC")" = "10143" ] || { echo "refusing: not Monad testnet (10143)"; exit 1; }

KEY=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.empowertours/telegraph-sepolia.json")))["private_key"])')
mkdir -p deployments
OUT=deployments/monad-testnet.json
echo "{\"chainId\":10143,\"commit\":\"$(git rev-parse HEAD)\",\"srcTree\":\"$HEAD_SRC\",\"audit\":\"$REPORT\"," > "$OUT.tmp"
for c in BountyEscrow VulnerableVault PatchedVault; do
  addr=$(forge create "src/$c.sol:$c" --rpc-url "$RPC" --private-key "$KEY" --broadcast --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
  echo "  $c $addr"
  echo "\"$c\":\"$addr\"," >> "$OUT.tmp"
done
echo "\"deployedAt\":\"$(date -u +%FT%TZ)\"}" >> "$OUT.tmp"
python3 -c "import json;json.dump(json.loads(open('$OUT.tmp').read()),open('$OUT','w'),indent=1)" && rm "$OUT.tmp"
echo "wrote $OUT"
