#!/usr/bin/env node

/**
 * fix_editor_paragraph_wrap.js
 *
 * Editor-compat patch for already-converted aura-user-profile macros.
 *
 * Symptom: pages converted by an earlier run of sync_responsibility_to_aura.js
 * before commit X render fine in VIEW mode but the EDITOR refuses to
 * open them. Root cause: the source `responsible-person-macro` was
 * solo-wrapped in a <p>...</p> paragraph, and the splice preserved that
 * <p> wrapper. Aura is a block-level macro; Confluence's editor strictly
 * validates ADF and rejects block extensions nested inside a paragraph
 * node. The renderer is permissive so view mode still shows the cards.
 *
 * This script:
 *   1. CQL-finds (or accepts via --cloud-page-id) pages with
 *      aura-user-profile macros.
 *   2. For each, checks if any aura macro is solo-wrapped in <p>...</p>.
 *   3. If so, splices out the wrapping paragraph and inserts a self-
 *      closing <p /> placeholder before the macro (matching the shape
 *      of hand-crafted aura macros in the wild).
 *   4. PUTs the patched storage at version+1.
 *
 * USAGE
 *   node main/fix_editor_paragraph_wrap.js --space TEAM --dry-run
 *   node main/fix_editor_paragraph_wrap.js --space TEAM
 *   node main/fix_editor_paragraph_wrap.js --cloud-page-id 288063573,288064313
 *
 * Required env (already set up in .env for sync_responsibility_to_aura.js):
 *   CLOUD_BASE_URL, CLOUD_EMAIL, CLOUD_API_TOKEN
 */

"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

function parseArgs(argv) {
  const o = { space: null, all: false, cloudPageIds: [], dryRun: false, limit: 0, concurrency: 3, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--space": o.space = argv[++i]; break;
      case "--all": o.all = true; break;
      case "--cloud-page-id": {
        const v = argv[++i];
        if (v) o.cloudPageIds.push(...v.split(",").map(s => s.trim()).filter(Boolean));
        break;
      }
      case "--dry-run": o.dryRun = true; break;
      case "--limit": o.limit = parseInt(argv[++i], 10) || 0; break;
      case "--concurrency": o.concurrency = parseInt(argv[++i], 10) || 3; break;
      case "--help":
      case "-h": o.help = true; break;
    }
  }
  return o;
}

function help() {
  console.log(`
Usage: node main/fix_editor_paragraph_wrap.js [--space KEY | --all | --cloud-page-id IDs] [--dry-run]

  --space KEY            scan this space's aura-user-profile pages
  --all                  scan every space
  --cloud-page-id IDs    comma-separated explicit Cloud pageIds
  --dry-run              report what would change, do not PUT
  --limit N              cap pages processed
  --concurrency N        worker pool (default 3)
`);
}

/**
 * For each aura-user-profile macro in `xml`, check if it's wrapped in
 * a <p>...</p>. Returns a list of patch ops:
 *
 *   { paragraphStart, paragraphEnd, replacement }
 *
 * where `replacement` is the new content for that span:
 *   solo wrap:  "<p />" + macro
 *   mixed wrap: "<p>before</p>" (if non-empty) + macro + "<p>after</p>" (if non-empty)
 *                with an anchor "<p />" prefix when only `after` is non-empty
 *   no wrap:    not included in ops at all
 */
function findWrappedAuraMacros(xml) {
  const ops = [];
  const OPEN = "<ac:structured-macro ac:name=\"aura-user-profile\"";
  let idx = 0;
  while (true) {
    const macroOpenIdx = xml.indexOf(OPEN, idx);
    if (macroOpenIdx === -1) break;
    const closeIdx = xml.indexOf("</ac:structured-macro>", macroOpenIdx);
    if (closeIdx === -1) break;
    const macroEnd = closeIdx + "</ac:structured-macro>".length;
    const macroXml = xml.substring(macroOpenIdx, macroEnd);

    // Find the nearest enclosing <p> ... </p>
    let pOpenIdx = -1, pOpenEnd = -1;
    let cursor = macroOpenIdx;
    while (cursor > 0) {
      const i = xml.lastIndexOf("<p", cursor);
      if (i === -1) break;
      const next = xml[i + 2];
      if (next === ">" || next === " " || next === "\t" || next === "\n" || next === "/") {
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd === -1) { cursor = i - 1; continue; }
        const openTag = xml.substring(i, tagEnd + 1);
        if (openTag.endsWith("/>")) { cursor = i - 1; continue; }
        const close = xml.indexOf("</p>", tagEnd + 1);
        if (close === -1 || close < macroEnd) { cursor = i - 1; continue; }
        pOpenIdx = i;
        pOpenEnd = tagEnd + 1;
        break;
      }
      cursor = i - 1;
    }
    if (pOpenIdx === -1) {
      // Not wrapped — skip
      idx = macroEnd;
      continue;
    }
    const pCloseIdx = xml.indexOf("</p>", macroEnd);
    if (pCloseIdx === -1) { idx = macroEnd; continue; }
    const pEnd = pCloseIdx + 4;

    const before = xml.substring(pOpenEnd, macroOpenIdx);
    const after = xml.substring(macroEnd, pCloseIdx);
    const beforeTrim = before.trim();
    const afterTrim = after.trim();

    let replacement;
    if (!beforeTrim && !afterTrim) {
      // solo
      replacement = "<p />" + macroXml;
    } else {
      // mixed
      let prefix = "";
      let suffix = "";
      if (beforeTrim) prefix = `<p>${before}</p>`;
      if (afterTrim) suffix = `<p>${after}</p>`;
      if (!prefix) prefix = "<p />";
      replacement = prefix + macroXml + suffix;
    }
    ops.push({
      paragraphStart: pOpenIdx,
      paragraphEnd: pEnd,
      replacement,
      kind: !beforeTrim && !afterTrim ? "solo" : "mixed",
    });
    idx = pEnd;
  }
  return ops;
}

function applyOps(xml, ops) {
  if (ops.length === 0) return xml;
  // Apply back-to-front
  const sorted = ops.slice().sort((a, b) => b.paragraphStart - a.paragraphStart);
  let cur = xml;
  for (const op of sorted) {
    cur = cur.slice(0, op.paragraphStart) + op.replacement + cur.slice(op.paragraphEnd);
  }
  return cur;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }
  if (!opts.space && !opts.all && opts.cloudPageIds.length === 0) {
    console.error("Pick one: --space KEY | --all | --cloud-page-id IDs");
    process.exit(1);
  }
  if (!process.env.CLOUD_BASE_URL || !process.env.CLOUD_EMAIL || !process.env.CLOUD_API_TOKEN) {
    console.error("Missing CLOUD_BASE_URL, CLOUD_EMAIL or CLOUD_API_TOKEN in .env");
    process.exit(1);
  }

  const client = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  const stats = { scanned: 0, withWrap: 0, patched: 0, failed: 0, skipped: 0 };

  const processPage = async (pageId) => {
    stats.scanned++;
    let page;
    try {
      page = await client.getPageStorage(pageId);
    } catch (e) {
      stats.failed++;
      console.log(`  [${pageId}] fetch failed: ${e.message}`);
      return;
    }
    const xml = page.body?.storage?.value || "";
    const v = page.version?.number;
    if (!xml || !v) { stats.skipped++; console.log(`  [${pageId}] empty storage`); return; }

    const ops = findWrappedAuraMacros(xml);
    if (ops.length === 0) {
      console.log(`  [${pageId}] "${page.title}" — no solo-wrapped aura macro (ok)`);
      return;
    }
    stats.withWrap++;
    console.log(`  [${pageId}] "${page.title}" v${v} — ${ops.length} solo-wrapped aura macro(s) to patch`);

    if (opts.dryRun) {
      console.log(`    [DRY RUN] would patch ${ops.length} wrapper(s)`);
      return;
    }
    const newXml = applyOps(xml, ops);
    const res = await client.updatePageStorage(
      pageId, page.title, page.type || "page", newXml, v,
      "Aura editor-compat patch: remove enclosing <p> around block macro",
    );
    if (res.success) {
      stats.patched++;
      console.log(`    [${pageId}] patched -> v${res.newVersion || v + 1}`);
    } else {
      stats.failed++;
      console.log(`    [${pageId}] PUT FAILED: ${res.error}`);
    }
  };

  // Collect target pages
  let targets = [];
  if (opts.cloudPageIds.length > 0) {
    targets = opts.cloudPageIds.slice();
  } else {
    const cql = opts.space
      ? `space = "${opts.space}" AND macro = "aura-user-profile" AND type = page ORDER BY id`
      : `macro = "aura-user-profile" AND type = page ORDER BY id`;
    console.log(`CQL: ${cql}`);
    let stop = false;
    await client.searchContentByCql(cql, "version,space", async (results) => {
      for (const p of results) {
        targets.push(String(p.id));
        if (opts.limit > 0 && targets.length >= opts.limit) { stop = true; break; }
      }
      if (stop) return false;
    });
  }
  console.log(`\nTargets: ${targets.length} page(s)${opts.dryRun ? " [DRY RUN]" : ""}\n`);

  // Sequential is fine — small N, write workload
  for (const id of targets) {
    try { await processPage(id); }
    catch (e) { stats.failed++; console.log(`  [${id}] error: ${e.message}`); }
  }

  console.log("\n=== Summary ===");
  console.log(JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
}
