// Usage: node verifier/cli.js <proof.sol>
// Prints the verdict JSON and its hash. Exit 0 = valid proof, 1 = rejected, 2 = error.
import fs from "node:fs";
import { verifyProof } from "./verify.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node verifier/cli.js <proof.sol>");
  process.exit(2);
}
try {
  const { verdict, verdictHash } = await verifyProof(
    fs.readFileSync(file, "utf8"),
  );
  console.log(
    JSON.stringify({ verdict_hash: verdictHash, ...verdict }, null, 2),
  );
  process.exit(verdict.valid ? 0 : 1);
} catch (e) {
  console.error(`verifier error: ${e.message}`);
  process.exit(2);
}
