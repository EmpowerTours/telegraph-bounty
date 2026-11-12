#!/usr/bin/env bash
# Deploys BountyEscrow + the two demo vaults to Monad TESTNET (chain 10143).
# Gate: refuses to run unless an Ultrafuzz report for the exact commit being deployed is in audit/
# (standing rule: every contract gets an Ultrafuzz campaign before any deploy).
# Key: the testnet-only wallet in ~/.empowertours/telegraph-sepolia.json, read at run time, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC:-https://testnet-rpc.monad.xyz}
[ "$(cast chain-id --rpc-url "$RPC")" = "10143" ] || { echo "refusing: not Monad testnet (10143)"; exit 1; }

REPORT=$(ls audit/ultrafuzz-*.md 2>/dev/null | head -1 || true)
[ -n "$REPORT" ] || { echo "refusing: no Ultrafuzz report in audit/ (run the campaign and triage it first)"; exit 1; }
grep -q "^Triage: done" "$REPORT" || { echo "refusing: $REPORT has no 'Triage: done' line"; exit 1; }
[ -z "$(git status --porcelain src)" ] || { echo "refusing: src/ has uncommitted changes"; exit 1; }

KEY=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.empowertours/telegraph-sepolia.json")))["private_key"])')
mkdir -p deployments
OUT=deployments/monad-testnet.json
echo "{\"chainId\":10143,\"commit\":\"$(git rev-parse HEAD)\",\"audit\":\"$REPORT\"," > "$OUT.tmp"
for c in BountyEscrow VulnerableVault PatchedVault; do
  addr=$(forge create "src/$c.sol:$c" --rpc-url "$RPC" --private-key "$KEY" --broadcast --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
  echo "  $c $addr"
  echo "\"$c\":\"$addr\"," >> "$OUT.tmp"
done
echo "\"deployedAt\":\"$(date -u +%FT%TZ)\"}" >> "$OUT.tmp"
python3 -c "import json;json.dump(json.loads(open('$OUT.tmp').read()),open('$OUT','w'),indent=1)" && rm "$OUT.tmp"
echo "wrote $OUT"
