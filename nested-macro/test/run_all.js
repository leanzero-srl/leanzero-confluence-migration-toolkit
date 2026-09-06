#!/usr/bin/env node

/**
 * Run the full local test suite:
 *   1. Phase-0 round-trip POC (parser fidelity)
 *   2. Unit tests (detector + un-nest algorithm)
 *
 * Each suite exits non-zero on failure; this wrapper aggregates so one
 * invocation covers everything.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const suites = [
  { name: "Phase 0 POC (round-trip)", file: "test_round_trip.js" },
  { name: "Unit tests (detector + un-nest)", file: "test_unnest.js" },
  { name: "Integration: 409 retry semantics", file: "test_409_retry.js" },
];

let anyFailed = false;
for (const suite of suites) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${suite.name}`);
  console.log("=".repeat(60));
  const res = spawnSync("node", [path.join(__dirname, suite.file)], {
    stdio: "inherit",
  });
  if (res.status !== 0) anyFailed = true;
}

console.log("\n" + "=".repeat(60));
console.log(anyFailed ? "SUITE FAILED" : "ALL SUITES PASSED");
console.log("=".repeat(60));
process.exit(anyFailed ? 1 : 0);
