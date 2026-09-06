#!/usr/bin/env node

/**
 * TEST 3: End-to-end - Find DC HTML macro, find Cloud page, replace one macro
 *
 * This is the full pipeline for a single page:
 *   1. Search DC for a page with HTML macros
 *   2. Find the matching Cloud page
 *   3. Show the before state (DC macro content vs Cloud macro content)
 *   4. Replace the Cloud macro with the DC HTML content
 *   5. Show the after state
 *
 * Uses the same extraction, replacement, and update logic from the main script.
 *
 * IMPORTANT: This WILL modify a Cloud page unless --dry-run is passed.
 *
 * Usage:
 *   node test/test3_replace_one_macro.js --dry-run                  # preview only
 *   node test/test3_replace_one_macro.js --space PROJ --dry-run     # preview for a specific space
 *   node test/test3_replace_one_macro.js --space PROJ               # LIVE: actually modify Cloud
 *   node test/test3_replace_one_macro.js --mode macro --dry-run     # preview with macro mode
 *
 * Options:
 *   --dry-run          Preview only, do not modify Cloud (default: on)
 *   --live             Actually modify the Cloud page (turns off dry-run)
 *   --space <KEY>      Filter to a specific space
 *   --mode <raw|macro> Replacement mode (default: raw)
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
  const opts = { space: null, dryRun: true, mode: "raw", macroTypes: ["html", "css"] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--space" && args[i + 1]) opts.space = args[++i];
    if (args[i] === "--dry-run") opts.dryRun = true;
    if (args[i] === "--live") opts.dryRun = false;
    if (args[i] === "--mode" && args[i + 1]) opts.mode = args[++i];
    if (args[i] === "--macro-type" && args[i + 1]) {
      opts.macroTypes = args[++i].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }
  return opts;
}

function printMacroContent(label, content, maxLen) {
  const max = maxLen || 500;
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

  log("=== TEST 3: End-to-end macro replacement ===");
  log(`DC URL:    ${process.env.DC_BASE_URL}`);
  log(`Cloud URL: ${process.env.CLOUD_BASE_URL}`);
  if (opts.space) log(`Space filter: ${opts.space}`);
  log(`Macro types: ${opts.macroTypes.join(", ")}`);
  log(`Replacement mode: ${opts.mode}`);

  if (opts.dryRun) {
    log("*** DRY RUN - No changes will be made ***");
    log("    Pass --live to actually modify Cloud pages");
  } else {
    log("*** LIVE MODE - Cloud page WILL be modified ***");
  }
  log("");

  // Same clients from main script
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

  // Same processor from main script
  const processor = new HtmlMacroProcessor(dcClient, cloudClient, null, {
    dryRun: opts.dryRun,
    replacementMode: opts.mode,
    log,
  });

  // ── Step 1: Test connections ──
  log("Step 1: Testing connections...");

  const dcOk = await dcClient.testConnection();
  if (!dcOk) {
    log("FAILED: Cannot connect to DC.");
    process.exit(1);
  }
  log("  DC: OK");

  const cloudOk = await cloudClient.testConnection();
  if (!cloudOk) {
    log("FAILED: Cannot connect to Cloud.");
    process.exit(1);
  }
  log("  Cloud: OK\n");

  // ── Step 2: Find a DC page with macros ──
  log("Step 2: Finding a DC page with macros...");

  const allDcPages = new Map();
  for (const macroType of opts.macroTypes) {
    let cql = `macro = "${macroType}" AND type = page`;
    if (opts.space) {
      cql = `space = "${opts.space}" AND ${cql}`;
    }

    const apiPath =
      "/rest/api/content/search?cql=" +
      encodeURIComponent(cql) +
      "&expand=space,body.storage,version&limit=10";

    const response = await dcClient.makeRequest("GET", apiPath);
    const typeResults = response.results || [];
    log(`  ${macroType.toUpperCase()}: Found ${typeResults.length} candidate DC pages`);

    for (const page of typeResults) {
      if (!allDcPages.has(page.id)) {
        allDcPages.set(page.id, page);
      }
    }
  }

  const dcPages = Array.from(allDcPages.values());

  if (dcPages.length === 0) {
    log("No DC pages with macros found. Try a different --space.");
    process.exit(0);
  }
  log(`  Total unique candidate DC pages: ${dcPages.length}`);

  // ── Step 3: Find one that has a Cloud match with differing macros ──
  log("\nStep 3: Finding a DC page that has a Cloud match with different macros...");

  let targetDcPage = null;
  let targetCloudPage = null;
  // Store macros per type: { html: { dc: [], cloud: [] }, css: { dc: [], cloud: [] } }
  let targetMacrosByType = {};

  for (const page of dcPages) {
    const storageBody = page.body && page.body.storage && page.body.storage.value;
    const spaceKey = page.space && page.space.key;
    if (!storageBody || !spaceKey) continue;

    // Extract macros for all configured types
    const macrosByType = {};
    let totalMacros = 0;
    for (const macroType of opts.macroTypes) {
      const macros = processor.extractMacros(storageBody, macroType);
      macrosByType[macroType] = { dc: macros };
      totalMacros += macros.length;
    }
    if (totalMacros === 0) continue;

    const macroSummary = opts.macroTypes
      .filter((t) => macrosByType[t].dc.length > 0)
      .map((t) => `${macrosByType[t].dc.length} ${t.toUpperCase()}`)
      .join(", ");
    log(`  Checking: "${page.title}" (${spaceKey}, ${macroSummary})...`);

    const cloudPage = await cloudClient.findPageBySpaceAndTitle(spaceKey, page.title);
    if (!cloudPage) {
      log(`    Not found in Cloud, skipping`);
      continue;
    }

    const cloudBody = cloudPage.body && cloudPage.body.storage && cloudPage.body.storage.value;
    if (!cloudBody) {
      log(`    Cloud page has no body, skipping`);
      continue;
    }

    // Extract cloud macros and check sync status per type
    let allInSync = true;
    for (const macroType of opts.macroTypes) {
      const cloudMacros = processor.extractMacros(cloudBody, macroType);
      macrosByType[macroType].cloud = cloudMacros;

      if (macrosByType[macroType].dc.length > 0) {
        if (!processor._macrosAlreadyInSync(macrosByType[macroType].dc, cloudMacros)) {
          allInSync = false;
        }
      }
    }

    if (allInSync) {
      log(`    Already in sync, skipping (looking for one that differs)`);
      // Save as fallback in case all are in sync
      if (!targetDcPage) {
        targetDcPage = page;
        targetCloudPage = cloudPage;
        targetMacrosByType = macrosByType;
      }
      continue;
    }

    // Found a page with differing macros
    targetDcPage = page;
    targetCloudPage = cloudPage;
    targetMacrosByType = macrosByType;
    log(`    SELECTED: macros differ between DC and Cloud`);
    break;
  }

  if (!targetDcPage || !targetCloudPage) {
    log("\nNo suitable page found with both DC macros and Cloud match. Try a different --space.");
    process.exit(0);
  }

  const spaceKey = targetDcPage.space && targetDcPage.space.key;

  // ── Step 4: Show BEFORE state ──
  console.log("\n" + "═".repeat(70));
  console.log("SELECTED PAGE");
  console.log("═".repeat(70));
  console.log(`  Title:       ${targetDcPage.title}`);
  console.log(`  Space:       ${spaceKey}`);
  console.log(`  DC Page ID:  ${targetDcPage.id}`);
  console.log(`  DC Version:  ${targetDcPage.version && targetDcPage.version.number}`);
  console.log(`  DC URL:      ${process.env.DC_BASE_URL}/pages/viewpage.action?pageId=${targetDcPage.id}`);
  console.log(`  Cloud ID:    ${targetCloudPage.id}`);
  console.log(`  Cloud Ver:   ${targetCloudPage.version && targetCloudPage.version.number}`);
  console.log(`  Cloud URL:   ${process.env.CLOUD_BASE_URL.replace("/wiki", "")}/wiki/pages/${targetCloudPage.id}`);
  console.log("");

  for (const macroType of opts.macroTypes) {
    const label = macroType.toUpperCase();
    const dcMacros = targetMacrosByType[macroType]?.dc || [];
    const cloudMacros = targetMacrosByType[macroType]?.cloud || [];
    if (dcMacros.length === 0 && cloudMacros.length === 0) continue;

    const inSync = processor._macrosAlreadyInSync(dcMacros, cloudMacros);
    console.log(`  ${label} sync status: ${inSync ? "ALREADY IN SYNC" : "MACROS DIFFER"}`);
    console.log(`  ${label} DC macros:   ${dcMacros.length}`);
    console.log(`  ${label} Cloud macros: ${cloudMacros.length}`);
  }

  console.log("\n── BEFORE STATE ──\n");

  for (const macroType of opts.macroTypes) {
    const label = macroType.toUpperCase();
    const dcMacros = targetMacrosByType[macroType]?.dc || [];
    const cloudMacros = targetMacrosByType[macroType]?.cloud || [];
    if (dcMacros.length === 0 && cloudMacros.length === 0) continue;

    const matchCount = Math.min(dcMacros.length, cloudMacros.length);
    for (let i = 0; i < matchCount; i++) {
      console.log(`  ${label} Macro #${i + 1}:`);
      printMacroContent(`DC ${label} content`, dcMacros[i].content);
      console.log("");
      printMacroContent(`Cloud ${label} content`, cloudMacros[i].content);
      const same = dcMacros[i].content.trim() === cloudMacros[i].content.trim();
      console.log(`  Match: ${same ? "IDENTICAL" : "DIFFERENT"}`);
      console.log("");
    }
  }

  // ── Step 5: Perform replacement ──
  console.log("── REPLACEMENT ──\n");
  log(`Replacement mode: ${opts.mode}`);

  // Fetch fresh Cloud page content (same as _updateCloudPage does)
  const freshCloudPage = await cloudClient.getPageContent(targetCloudPage.id);
  const freshCloudBody = freshCloudPage.body && freshCloudPage.body.storage && freshCloudPage.body.storage.value;
  const currentVersion = freshCloudPage.version && freshCloudPage.version.number;
  const pageTitle = freshCloudPage.title || targetDcPage.title;

  if (!freshCloudBody) {
    log("ERROR: Fresh Cloud page has no storage body");
    process.exit(1);
  }

  // Apply replacements for each macro type sequentially
  let newBody = freshCloudBody;
  let totalReplacements = 0;

  for (const macroType of opts.macroTypes) {
    const dcMacros = targetMacrosByType[macroType]?.dc || [];
    if (dcMacros.length === 0) continue;

    const label = macroType.toUpperCase();
    const planMacros = dcMacros.map((m) => ({
      index: m.index,
      dcContent: m.content,
    }));

    const { newBody: updatedBody, replacementsMade } = processor.replaceMacros(
      newBody,
      planMacros,
      opts.mode,
      macroType,
    );
    newBody = updatedBody;
    totalReplacements += replacementsMade;
    log(`  ${label} replacements made: ${replacementsMade}`);
  }

  log(`Total replacements: ${totalReplacements}`);
  log(`Body changed: ${newBody !== freshCloudBody ? "YES" : "NO"}`);

  if (totalReplacements === 0 || newBody === freshCloudBody) {
    log("\nNo changes to apply. The Cloud page may already have the correct content.");
    process.exit(0);
  }

  // Show what the new body looks like for the macro areas
  console.log("\n── AFTER STATE (preview) ──\n");

  for (const macroType of opts.macroTypes) {
    const label = macroType.toUpperCase();
    const dcMacros = targetMacrosByType[macroType]?.dc || [];
    if (dcMacros.length === 0) continue;

    const newMacros = processor.extractMacros(newBody, macroType);

    if (opts.mode === "raw") {
      console.log(`  (In 'raw' mode, ${label} macros are replaced with inline content -`);
      console.log(`   extractMacros will find 0 macros in the new body since wrappers are removed)\n`);
      console.log(`  ${label} macros in new body: ${newMacros.length}`);

      // Show a diff-like preview of the area around the first replacement
      const firstDcContent = dcMacros[0].content;
      const idx = newBody.indexOf(firstDcContent);
      if (idx >= 0) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(newBody.length, idx + firstDcContent.length + 50);
        console.log(`\n  Snippet around first ${label} replacement:`);
        printMacroContent("New body excerpt", newBody.substring(start, end), 600);
      }
    } else {
      console.log(`  ${label} macros in new body: ${newMacros.length}`);
      for (let i = 0; i < newMacros.length; i++) {
        printMacroContent(`New ${label} Macro #${i + 1}`, newMacros[i].content);
        console.log("");
      }
    }
  }

  // ── Step 6: Apply or skip ──
  if (opts.dryRun) {
    console.log("\n── DRY RUN ── No changes applied to Cloud.\n");
    log("To apply this change for real, run again with --live:");
    log(`  node test/test3_replace_one_macro.js${opts.space ? " --space " + opts.space : ""} --mode ${opts.mode} --live`);
  } else {
    console.log("\n── APPLYING CHANGE TO CLOUD ──\n");
    log(`Updating Cloud page ${targetCloudPage.id} (version ${currentVersion} -> ${currentVersion + 1})...`);

    // Use the same updatePageContent from our Cloud client
    const result = await cloudClient.updatePageContent(
      targetCloudPage.id,
      pageTitle,
      newBody,
      currentVersion,
    );

    if (result.success) {
      log("SUCCESS: Cloud page updated.");
      log(`Check it: ${process.env.CLOUD_BASE_URL.replace("/wiki", "")}/wiki/pages/${targetCloudPage.id}`);

      // Verify by re-fetching
      log("\nVerifying...");
      const verifyPage = await cloudClient.getPageContent(targetCloudPage.id);
      const verifyBody = verifyPage.body && verifyPage.body.storage && verifyPage.body.storage.value;
      const verifyVersion = verifyPage.version && verifyPage.version.number;
      log(`  New version: ${verifyVersion}`);
      log(`  Body matches expected: ${verifyBody === newBody ? "YES" : "NO"}`);
    } else {
      log(`FAILED: ${result.error}`);
    }
  }

  // Final stats
  const dcStats = dcClient.getStats();
  const cloudStats = cloudClient.getStats();
  console.log("\n" + "─".repeat(70));
  log(`DC API:    ${dcStats.requestCount} requests, ${dcStats.errorCount} errors`);
  log(`Cloud API: ${cloudStats.requestCount} requests, ${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
