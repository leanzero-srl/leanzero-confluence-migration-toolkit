#!/usr/bin/env node

/**
 * TEST 1: Find a page in DC that has an HTML macro
 *
 * Connects to DC, searches for pages with HTML macros using CQL,
 * extracts macro content using our HtmlMacroProcessor, and prints
 * everything you need to verify in the DC UI.
 *
 * Usage:
 *   node test/test1_find_dc_html_page.js
 *   node test/test1_find_dc_html_page.js --space PROJ
 *   node test/test1_find_dc_html_page.js --limit 10
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const HtmlMacroProcessor = require("../src/htmlMacroProcessor");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { space: null, limit: 5, macroTypes: ["html", "css"] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--space" && args[i + 1]) opts.space = args[++i];
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i], 10) || 5;
    if (args[i] === "--macro-type" && args[i + 1]) {
      opts.macroTypes = args[++i].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  log("=== TEST 1: Find DC page with HTML/CSS macros ===");
  log(`DC URL: ${process.env.DC_BASE_URL}`);
  if (opts.space) log(`Space filter: ${opts.space}`);
  log(`Macro types: ${opts.macroTypes.join(", ")}`);
  log(`Result limit: ${opts.limit}`);
  log("");

  // Use the same client from our main script
  const dcClient = new DatacenterConfluenceClient(
    process.env.DC_BASE_URL,
    process.env.DC_USERNAME,
    process.env.DC_PASSWORD,
  );

  // Use the same processor from our main script for macro extraction
  const processor = new HtmlMacroProcessor(dcClient, null, null, { log });

  // Test connection
  log("Testing DC connection...");
  const ok = await dcClient.testConnection();
  if (!ok) {
    log("FAILED: Cannot connect to Confluence DC. Is the instance up?");
    process.exit(1);
  }
  log("DC connection: OK\n");

  // Search for each macro type
  const allResults = new Map(); // pageId -> page object

  for (const macroType of opts.macroTypes) {
    let cql = `macro = "${macroType}" AND type = page`;
    if (opts.space) {
      cql = `space = "${opts.space}" AND ${cql}`;
    }
    log(`CQL (${macroType.toUpperCase()}): ${cql}`);

    const apiPath =
      "/rest/api/content/search?cql=" +
      encodeURIComponent(cql) +
      "&expand=space,body.storage,version&limit=" +
      opts.limit;

    const response = await dcClient.makeRequest("GET", apiPath);
    const results = response.results || [];
    log(`  Found ${results.length} page(s) with ${macroType.toUpperCase()} macros`);

    for (const page of results) {
      if (!allResults.has(page.id)) {
        allResults.set(page.id, page);
      }
    }
  }

  const results = Array.from(allResults.values());
  log(`\nTotal unique pages: ${results.length}\n`);

  if (results.length === 0) {
    log("No pages found. Try a different space or remove the --space filter.");
    process.exit(0);
  }

  // Process each result using our actual extraction logic
  for (let i = 0; i < results.length; i++) {
    const page = results[i];
    const storageBody = page.body && page.body.storage && page.body.storage.value;
    const spaceKey = page.space && page.space.key;

    console.log("─".repeat(70));
    console.log(`PAGE ${i + 1}:`);
    console.log(`  Page ID:    ${page.id}`);
    console.log(`  Title:      ${page.title}`);
    console.log(`  Space:      ${spaceKey}`);
    console.log(`  Version:    ${page.version && page.version.number}`);
    console.log(`  DC URL:     ${process.env.DC_BASE_URL}/pages/viewpage.action?pageId=${page.id}`);
    console.log("");

    if (!storageBody) {
      console.log("  [No storage body available]");
      continue;
    }

    // Extract macros for each configured type
    for (const macroType of opts.macroTypes) {
      const label = macroType.toUpperCase();
      const macros = processor.extractMacros(storageBody, macroType);
      console.log(`  ${label} Macros found: ${macros.length}`);

      for (let j = 0; j < macros.length; j++) {
        const macro = macros[j];
        console.log("");
        console.log(`  --- ${label} Macro #${j + 1} ---`);
        console.log(`  Content length: ${macro.content.length} chars`);
        console.log(`  Full match length: ${macro.fullMatch.length} chars`);
        console.log("");
        console.log("  Content preview (first 500 chars):");
        console.log("  ┌" + "─".repeat(60));
        const lines = macro.content.substring(0, 500).split("\n");
        for (const line of lines) {
          console.log("  │ " + line);
        }
        if (macro.content.length > 500) {
          console.log("  │ ...(truncated)");
        }
        console.log("  └" + "─".repeat(60));
      }
    }
    console.log("");
  }

  console.log("─".repeat(70));
  log("\nDone. Use the Page IDs and URLs above to verify in the DC UI.");
  log("Copy a Page ID and Space Key for use in test2 and test3.");

  const dcStats = dcClient.getStats();
  log(`\nAPI stats: ${dcStats.requestCount} requests, ${dcStats.errorCount} errors`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
