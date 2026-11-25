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
    # Full 40-hex SHAs only: a short SHA is resolved as a ref name first, so a tag or branch
    # named after it could point the gate at HEAD.
    [ "$(git cat-file -t "$c" || true)" = "commit" ] || { echo "skip Commit $c in $r: not a commit object here"; continue; }
    t=$(git rev-parse --verify "$c:src")
    [ "$t" = "$HEAD_SRC" ] && matched="Commit $c (src tree $t)"
  done < <(sed -n 's/^Commit: *\([0-9a-f]\{40\}\)\b.*/\1/p' "$r")
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
declare -A ADDR
for c in BountyEscrow VulnerableVault PatchedVault; do
  ADDR[$c]=$(forge create "src/$c.sol:$c" --rpc-url "$RPC" --private-key "$KEY" --broadcast --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
  echo "  $c ${ADDR[$c]}"
done
OUT="$OUT" COMMIT="$(git rev-parse HEAD)" SRC_TREE="$HEAD_SRC" REPORT="$REPORT" \
  BountyEscrow="${ADDR[BountyEscrow]}" VulnerableVault="${ADDR[VulnerableVault]}" PatchedVault="${ADDR[PatchedVault]}" \
  python3 - <<'PY' || { echo "refusing: manifest write failed; $OUT not updated"; exit 1; }
import datetime, json, os, re
e = os.environ
addrs = {c: e[c] for c in ("BountyEscrow", "VulnerableVault", "PatchedVault")}
for c, a in addrs.items():
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a):
        raise SystemExit(f"bad address for {c}: {a!r}")
m = {"chainId": 10143, "commit": e["COMMIT"], "srcTree": e["SRC_TREE"], "audit": e["REPORT"], **addrs,
     "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
tmp = e["OUT"] + ".tmp"
with open(tmp, "w") as f:
    json.dump(m, f, indent=1)
os.replace(tmp, e["OUT"])
PY
echo "wrote $OUT"
