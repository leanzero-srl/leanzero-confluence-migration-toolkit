#!/usr/bin/env node

/**
 * TEST 2: Find an HTML macro page in DC and its corresponding Cloud page
 *
 * Searches DC for a page with HTML macros, then looks up the same page in
 * Cloud by space key + title. Shows both DC and Cloud macro content side by
 * side so you can verify the match in both UIs.
 *
 * Usage:
 *   node test/test2_find_dc_and_cloud_page.js
 *   node test/test2_find_dc_and_cloud_page.js --space PROJ
 *   node test/test2_find_dc_and_cloud_page.js --space PROJ --limit 3
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const HtmlMacroProcessor = require("../src/htmlMacroProcessor");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { space: null, limit: 3, macroTypes: ["html", "css"] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--space" && args[i + 1]) opts.space = args[++i];
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i], 10) || 3;
    if (args[i] === "--macro-type" && args[i + 1]) {
      opts.macroTypes = args[++i].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }
  return opts;
}

function printMacroContent(label, content, maxLen) {
  const max = maxLen || 400;
  console.log(`  ${label} (${content.length} chars):`);
  console.log("  ┌" + "─".repeat(60));
  const lines = content.substring(0, max).split("\n");
  for (const line of lines) {
    console.log("  │ " + line);
  }
  if (content.length > max) {
    console.log("  │ ...(truncated)");
  }
  console.log("  └" + "─".repeat(60));
}

async function main() {
  const opts = parseArgs();

  log("=== TEST 2: Find DC HTML/CSS macro page + match in Cloud ===");
  log(`DC URL:    ${process.env.DC_BASE_URL}`);
  log(`Cloud URL: ${process.env.CLOUD_BASE_URL}`);
  if (opts.space) log(`Space filter: ${opts.space}`);
  log(`Macro types: ${opts.macroTypes.join(", ")}`);
  log(`Result limit: ${opts.limit}`);
  log("");

  // Use the same clients from our main script
  const dcClient = new DatacenterConfluenceClient(
    process.env.DC_BASE_URL,
    process.env.DC_USERNAME,
    process.env.DC_PASSWORD,
  );
  const cloudClient = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  // Use the same processor from our main script
  const processor = new HtmlMacroProcessor(dcClient, cloudClient, null, { log });

  // Test connections
  log("Testing DC connection...");
  const dcOk = await dcClient.testConnection();
  if (!dcOk) {
    log("FAILED: Cannot connect to Confluence DC.");
    process.exit(1);
  }
  log("DC connection: OK");

  log("Testing Cloud connection...");
  const cloudOk = await cloudClient.testConnection();
  if (!cloudOk) {
    log("FAILED: Cannot connect to Confluence Cloud.");
    process.exit(1);
  }
  log("Cloud connection: OK\n");

  // Search DC for pages with macros (all configured types)
  const allResults = new Map();

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
    const typeResults = response.results || [];
    log(`  Found ${typeResults.length} page(s) with ${macroType.toUpperCase()} macros`);

    for (const page of typeResults) {
      if (!allResults.has(page.id)) {
        allResults.set(page.id, page);
      }
    }
  }

  const results = Array.from(allResults.values());
  log(`\nTotal unique DC pages: ${results.length}\n`);

  if (results.length === 0) {
    log("No pages found in DC. Try a different space or remove --space filter.");
    process.exit(0);
  }

  let matchCount = 0;

  for (let i = 0; i < results.length; i++) {
    const page = results[i];
    const storageBody = page.body && page.body.storage && page.body.storage.value;
    const spaceKey = page.space && page.space.key;

    console.log("═".repeat(70));
    console.log(`PAGE ${i + 1}: "${page.title}"`);
    console.log("═".repeat(70));

    // DC side
    console.log("\n  ── DC ──");
    console.log(`  Page ID:  ${page.id}`);
    console.log(`  Space:    ${spaceKey}`);
    console.log(`  Version:  ${page.version && page.version.number}`);
    console.log(`  URL:      ${process.env.DC_BASE_URL}/pages/viewpage.action?pageId=${page.id}`);

    if (!storageBody) {
      console.log("  [No storage body]");
      continue;
    }

    const dcMacrosByType = {};
    for (const macroType of opts.macroTypes) {
      const label = macroType.toUpperCase();
      const macros = processor.extractMacros(storageBody, macroType);
      dcMacrosByType[macroType] = macros;
      console.log(`  ${label} macros: ${macros.length}`);

      for (let j = 0; j < macros.length; j++) {
        console.log("");
        printMacroContent(`DC ${label} Macro #${j + 1}`, macros[j].content);
      }
    }

    // Cloud side - use the same findPageBySpaceAndTitle from our client
    console.log("\n  ── Cloud ──");
    log(`  Looking up Cloud page: space="${spaceKey}", title="${page.title}"`);

    const cloudPage = await cloudClient.findPageBySpaceAndTitle(spaceKey, page.title);

    if (!cloudPage) {
      console.log("  NOT FOUND in Cloud (page may not have been migrated)");
      console.log("");
      continue;
    }

    matchCount++;
    console.log(`  Page ID:  ${cloudPage.id}`);
    console.log(`  Version:  ${cloudPage.version && cloudPage.version.number}`);
    console.log(`  URL:      ${process.env.CLOUD_BASE_URL.replace("/wiki", "")}/wiki/pages/${cloudPage.id}`);

    const cloudStorageBody = cloudPage.body && cloudPage.body.storage && cloudPage.body.storage.value;

    if (!cloudStorageBody) {
      console.log("  [No storage body in Cloud]");
      continue;
    }

    for (const macroType of opts.macroTypes) {
      const label = macroType.toUpperCase();
      const dcMacros = dcMacrosByType[macroType] || [];
      const cloudMacros = processor.extractMacros(cloudStorageBody, macroType);
      console.log(`  ${label} macros: ${cloudMacros.length}`);

      for (let j = 0; j < cloudMacros.length; j++) {
        console.log("");
        printMacroContent(`Cloud ${label} Macro #${j + 1}`, cloudMacros[j].content);
      }

      // Compare using our actual _macrosAlreadyInSync method
      const inSync = processor._macrosAlreadyInSync(dcMacros, cloudMacros);
      console.log("");
      if (inSync) {
        console.log(`  ✓ ${label} SYNC STATUS: Macros are IDENTICAL (already in sync)`);
      } else {
        console.log(`  ✗ ${label} SYNC STATUS: Macros DIFFER (Cloud needs updating)`);
        if (dcMacros.length !== cloudMacros.length) {
          console.log(`    ${label} macro count mismatch: DC has ${dcMacros.length}, Cloud has ${cloudMacros.length}`);
        } else {
          for (let j = 0; j < dcMacros.length; j++) {
            const dcTrimmed = dcMacros[j].content.trim();
            const cloudTrimmed = cloudMacros[j].content.trim();
            if (dcTrimmed !== cloudTrimmed) {
              console.log(`    ${label} Macro #${j + 1}: content differs`);
            }
          }
        }
      }
    }
    console.log("");
  }

  console.log("═".repeat(70));
  log(`\nSummary: ${results.length} DC pages checked, ${matchCount} matched in Cloud`);

  const dcStats = dcClient.getStats();
  const cloudStats = cloudClient.getStats();
  log(`DC API:    ${dcStats.requestCount} requests, ${dcStats.errorCount} errors`);
  log(`Cloud API: ${cloudStats.requestCount} requests, ${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
