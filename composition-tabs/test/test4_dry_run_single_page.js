#!/usr/bin/env node

/**
 * Online: run a full plan-then-dry-run-execute cycle scoped to one page ID.
 * Useful for inspecting the diff before committing to an apply run.
 *
 * Usage:  node test/test4_dry_run_single_page.js <CLOUD_PAGE_ID>
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const CompositionMacroProcessor = require("../src/compositionMacroProcessor");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node test/test4_dry_run_single_page.js <CLOUD_PAGE_ID>");
    process.exit(1);
  }
  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );
  const sp = await cloud.getPageStorage(id);
  const storage = sp.body?.storage?.value || "";
  console.log(`Page: ${sp.title} (id=${sp.id}, version=${sp.version?.number})\n`);

  const proc = new CompositionMacroProcessor({ log: () => {} });
  const instances = proc.findCandidateMacros(storage);
  const { newXml, changes, skipped } = proc.rewriteStorage(storage, instances);

  console.log(`Instances:    ${instances.length}`);
  console.log(`Changes:      ${changes.length}`);
  console.log(`Skipped:      ${skipped.length}  (${skipped.map((s) => s.reason).join(", ")})`);
  console.log(`Byte-diff:    ${storage.length} -> ${newXml.length}`);
  console.log(`Identical:    ${newXml === storage}`);

  if (changes.length > 0) {
    console.log("\nFirst 5 changes:");
    for (const c of changes.slice(0, 5)) {
      console.log(`  - ${c.oldName} -> ${c.newName}  id=${c.macroId}  ancestor=${c.ancestor}  reason=${c.reason}` +
        `  paramRenames=[${c.paramRenames.map((r) => `${r.from}->${r.to}`).join(",")}]`);
    }
    console.log("\nUnified diff (first 3000 chars):");
    console.log(proc.unifiedDiff(storage, newXml).slice(0, 3000));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
