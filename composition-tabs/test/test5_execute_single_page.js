#!/usr/bin/env node

/**
 * Online: actually rewrite ONE page. Use only after test4 dry-run looks good.
 * Writes a backup and PUTs the page with the new storage XHTML.
 *
 * Usage:  node test/test5_execute_single_page.js <CLOUD_PAGE_ID>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const CompositionMacroProcessor = require("../src/compositionMacroProcessor");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node test/test5_execute_single_page.js <CLOUD_PAGE_ID>");
    process.exit(1);
  }
  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );
  const sp = await cloud.getPageStorage(id);
  const storage = sp.body?.storage?.value || "";
  const v = sp.version?.number;
  if (!storage || !v) { console.error("Empty storage or version"); process.exit(1); }

  const proc = new CompositionMacroProcessor({ log: () => {} });
  const instances = proc.findCandidateMacros(storage);
  const { newXml, changes } = proc.rewriteStorage(storage, instances);

  if (newXml === storage) {
    console.log("No-op: storage already in target shape.");
    return;
  }

  const backupDir = path.resolve(__dirname, "../backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `page_${id}_v${v}.xhtml`);
  fs.writeFileSync(backupPath, storage, "utf8");
  console.log(`Backup written: ${backupPath}`);
  console.log(`Pre/Post sha1: ${crypto.createHash("sha1").update(storage).digest("hex").slice(0,12)} / ${crypto.createHash("sha1").update(newXml).digest("hex").slice(0,12)}`);

  const r = await cloud.updatePageStorage(
    id, sp.title, sp.type || "page", newXml, v,
    "test5: Composition Tabs migration fix (single-page)",
  );
  if (r.success) {
    console.log(`OK: ${changes.length} macro(s) rewritten on page ${id}`);
  } else {
    console.error(`FAIL: ${r.error}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
