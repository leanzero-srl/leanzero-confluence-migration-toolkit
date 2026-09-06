#!/usr/bin/env node

/**
 * Offline regression test for compositionMacroProcessor.
 *
 * Loads each `*.before.xhtml` from `test/fixtures/`, runs
 * findCandidateMacros + rewriteStorage, and byte-compares the output to
 * the matching `*.after.xhtml`. Failure prints a unified diff.
 *
 * No network. Run with:  node test/test3_rewrite_fixture_pairs.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CompositionMacroProcessor = require("../src/compositionMacroProcessor");

const FIX_DIR = path.resolve(__dirname, "fixtures");

function listFixtures() {
  return fs.readdirSync(FIX_DIR)
    .filter((f) => f.endsWith(".before.xhtml"))
    .sort()
    .map((f) => f.replace(/\.before\.xhtml$/, ""));
}

function quickDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  let out = "";
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      out += `  line ${i + 1}:\n    expected: ${JSON.stringify(bl[i] || "")}\n    actual:   ${JSON.stringify(al[i] || "")}\n`;
    }
  }
  return out;
}

function runOne(stem) {
  const beforePath = path.join(FIX_DIR, `${stem}.before.xhtml`);
  const afterPath = path.join(FIX_DIR, `${stem}.after.xhtml`);
  const before = fs.readFileSync(beforePath, "utf8");
  const expected = fs.readFileSync(afterPath, "utf8");

  const proc = new CompositionMacroProcessor({ log: () => {} });
  const instances = proc.findCandidateMacros(before);
  const { newXml, changes, skipped } = proc.rewriteStorage(before, instances);

  if (newXml === expected) {
    console.log(`  ✓ ${stem}  (${changes.length} change(s), ${skipped.length} skipped)`);
    return true;
  }

  console.log(`  ✗ ${stem}  FAIL`);
  console.log(`    instances found: ${instances.length}`);
  console.log(`    changes: ${changes.length}, skipped: ${skipped.length}`);
  console.log(`    skip reasons: ${skipped.map((s) => s.reason).join(", ")}`);
  console.log(quickDiff(newXml, expected));
  return false;
}

function main() {
  const stems = listFixtures();
  console.log(`Running ${stems.length} fixture pair(s) from ${FIX_DIR}\n`);
  let passed = 0;
  let failed = 0;
  for (const s of stems) {
    if (runOne(s)) passed++;
    else failed++;
  }
  console.log(`\n${passed}/${stems.length} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
