// Loader for the held-out bounty targets. Each target lives in targets/<id>/ with a
// vulnerable source, a patched source and target.js (invariant + scenario).
//
// Directories whose name starts with "_" (and the forge test directory) are not targets and
// are never read by this loader. readTargetFile() refuses any path into such a directory, so
// code that only reads target files through this module cannot reach them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, toBytes, concat } from "viem";

export const TARGETS_DIR = path.dirname(fileURLToPath(import.meta.url));
const NOT_TARGETS = new Set(["test"]);

function isHidden(segment) {
  return segment.startsWith("_") || segment.startsWith(".");
}

/** Read a file under targets/, refusing hidden ("_"-prefixed) directories and path escapes. */
export function readTargetFile(rel) {
  const abs = path.resolve(TARGETS_DIR, rel);
  const relToRoot = path.relative(TARGETS_DIR, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot))
    throw new Error(`refusing to read outside targets/: ${rel}`);
  if (relToRoot.split(path.sep).some(isHidden))
    throw new Error(`refusing to read a hidden targets/ directory: ${rel}`);
  return fs.readFileSync(abs, "utf8");
}

export function listTargetIds() {
  return fs
    .readdirSync(TARGETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isHidden(d.name) && !NOT_TARGETS.has(d.name))
    .map((d) => d.name)
    .sort();
}

/** Hash that binds a bounty to the exact vulnerable source, patched source and scenario code. */
export function targetHashOf(vulnerableSource, patchedSource, scenarioSource) {
  return keccak256(
    concat([
      keccak256(toBytes(vulnerableSource)),
      keccak256(toBytes(patchedSource)),
      keccak256(toBytes(scenarioSource)),
    ]),
  );
}

export async function loadTarget(id) {
  if (!listTargetIds().includes(id)) throw new Error(`unknown target ${id}`);
  const scenarioSource = readTargetFile(`${id}/target.js`);
  const mod = await import(pathToFileURL(path.join(TARGETS_DIR, id, "target.js")).href);
  const spec = mod.default;
  if (spec.id !== id) throw new Error(`target.js id ${spec.id} != directory ${id}`);
  const vulnerableSource = readTargetFile(`${id}/${spec.vulnerable.file}`);
  const patchedSource = readTargetFile(`${id}/${spec.patched.file}`);
  return {
    ...spec,
    vulnerableSource,
    patchedSource,
    scenarioSource,
    targetHash: targetHashOf(vulnerableSource, patchedSource, scenarioSource),
    invariantHash: keccak256(toBytes(spec.invariant)),
  };
}

/**
 * Poster-side ground truth (bug class per target). Used only after a hunt, to score what the
 * paid third-party review said against what the deterministic verifier proved. Never prompted.
 */
export function loadGroundTruth() {
  const j = JSON.parse(readTargetFile("ground-truth.json"));
  delete j._note;
  return j;
}
