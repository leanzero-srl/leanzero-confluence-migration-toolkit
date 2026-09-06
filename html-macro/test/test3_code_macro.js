#!/usr/bin/env node

/**
 * TEST 3b: End-to-end - Find DC CSS/HTML macro, wrap content in Code macro for Cloud
 *
 * This test extracts HTML/CSS content from DC and wraps it inside a Code macro
 * when inserting into Cloud. This works because Confluence Cloud preserves
 * content inside Code macros (which use CDATA).
 *
 * Usage:
 *   node test/test3_code_macro.js --dry-run                  # preview only
 *   node test/test3_code_macro.js --live                     # LIVE: modify Cloud
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { space: null, dryRun: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--space" && args[i + 1]) opts.space = args[++i];
    if (args[i] === "--dry-run") opts.dryRun = true;
    if (args[i] === "--live") opts.dryRun = false;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  log("=== TEST 3b: Code macro wrapper for CSS/HTML content ===");
  log(`DC URL:    ${process.env.DC_BASE_URL}`);
  log(`Cloud URL: ${process.env.CLOUD_BASE_URL}`);

  if (opts.dryRun) {
    log("*** DRY RUN - No changes will be made ***");
  } else {
    log("*** LIVE MODE - Cloud page WILL be modified ***");
  }
  log("");

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

  // ── Step 1: Test connections ──
  log("Step 1: Testing connections...");
  if (!(await dcClient.testConnection())) {
    log("FAILED: Cannot connect to DC.");
    process.exit(1);
  }
  log("  DC: OK");
  
  if (!(await cloudClient.testConnection())) {
    log("FAILED: Cannot connect to Cloud.");
    process.exit(1);
  }
  log("  Cloud: OK\n");

  // ── Step 2: Find a DC page with HTML macros containing CSS/HTML content ──
  log("Step 2: Finding a DC page with HTML macros...");

  let cql = 'macro = "html" AND type = page';
  if (opts.space) {
    cql = `space = "${opts.space}" AND ${cql}`;
  }

  const apiPath =
    "/rest/api/content/search?cql=" +
    encodeURIComponent(cql) +
    "&expand=space,body.storage,version&limit=10";

  const response = await dcClient.makeRequest("GET", apiPath);
  const results = response.results || [];
  log(`  Found ${results.length} candidate DC pages`);

  if (results.length === 0) {
    log("No DC pages with HTML macros found.");
    process.exit(0);
  }

  // ── Step 3: Find matching Cloud page ──
  const page = results[0];
  const storageBody = page.body?.storage?.value;
  const spaceKey = page.space?.key;

  if (!storageBody || !spaceKey) {
    log("ERROR: Page missing required fields");
    process.exit(1);
  }

  log(`\\nSelected DC page: "${page.title}" (${spaceKey})`);
  log(`DC Page ID: ${page.id}`);

  const cloudPage = await cloudClient.findPageBySpaceAndTitle(spaceKey, page.title);
  if (!cloudPage) {
    log("ERROR: Cloud page not found");
    process.exit(1);
  }

  log(`Cloud Page ID: ${cloudPage.id}`);
  log(`Cloud URL: ${process.env.CLOUD_BASE_URL.replace("/wiki", "")}/wiki/pages/${cloudPage.id}\n`);

  // ── Step 4: Extract HTML macro content from DC and Cloud separately ──
  log("Step 4: Extracting HTML macros...");

  // Regex to find html macros (CDATA and plain-text variants)
  const macroRegex = /<ac:structured-macro[^>]*?ac:name\s*=\s*"html"[^>]*?>[\s\S]*?<ac:plain-text-body>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g;

  // Extract from DC
  const dcBody = storageBody;
  const dcHtmlMacros = [];
  let match;
  while ((match = macroRegex.exec(dcBody)) !== null) {
    dcHtmlMacros.push({
      index: dcHtmlMacros.length,
      content: match[1] || match[2] || "",
      fullMatch: match[0]
    });
  }
  log(`  DC HTML macros found: ${dcHtmlMacros.length}`);

  // Extract from Cloud
  let newBody = cloudPage.body?.storage?.value;
  if (!newBody) {
    log("ERROR: Cloud page has no storage body");
    process.exit(1);
  }

  const cloudHtmlMacros = [];
  macroRegex.lastIndex = 0; // reset regex state
  while ((match = macroRegex.exec(newBody)) !== null) {
    cloudHtmlMacros.push({
      index: cloudHtmlMacros.length,
      content: match[1] || match[2] || "",
      fullMatch: match[0]
    });
  }
  log(`  Cloud HTML macros found: ${cloudHtmlMacros.length}`);

  if (cloudHtmlMacros.length === 0) {
    log("WARNING: No HTML macros found in Cloud page body. Nothing to replace.");
    log("Cloud body preview (first 500 chars):");
    console.log(newBody.substring(0, 500));
    process.exit(0);
  }

  if (dcHtmlMacros.length !== cloudHtmlMacros.length) {
    log(`WARNING: Macro count mismatch - DC has ${dcHtmlMacros.length}, Cloud has ${cloudHtmlMacros.length}. Will match by position.`);
  }

  // ── Step 5: Build new body with Code macro wrapper ──
  log("\\nStep 5: Building replacement (Code macro wrapper)...");

  const matchCount = Math.min(dcHtmlMacros.length, cloudHtmlMacros.length);
  for (let i = matchCount - 1; i >= 0; i--) {
    const dcContent = dcHtmlMacros[i].content;
    const cloudFullMatch = cloudHtmlMacros[i].fullMatch;

    // Wrap the DC content in a Code macro structure
    // The code macro uses plain-text-body with CDATA — Cloud preserves CDATA content
    const codeMacro = `<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">html</ac:parameter><ac:plain-text-body><![CDATA[${dcContent}]]></ac:plain-text-body></ac:structured-macro>`;

    // Replace the Cloud's HTML macro with our Code macro
    newBody = newBody.replace(cloudFullMatch, codeMacro);
    log(`  Replaced Cloud HTML macro #${i + 1} with Code macro (DC content: ${dcContent.length} chars)`);
  }

  log(`\\nNew body length: ${newBody.length}`);
  
  // ── Step 6: Show preview ──
  console.log("\\n" + "═".repeat(70));
  console.log("BEFORE → AFTER PREVIEW");
  console.log("═".repeat(70));
  
  const htmlIdx = newBody.indexOf('<ac:structured-macro ac:name="code"');
  if (htmlIdx >= 0) {
    const start = Math.max(0, htmlIdx - 200);
    const end = Math.min(newBody.length, htmlIdx + 800);
    console.log("\\nSnippet around new Code macro:");
    console.log("─".repeat(70));
    console.log(newBody.substring(start, end));
    console.log("─".repeat(70));
    
    // Extract and show the CSS/HTML content
    const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(
      newBody.substring(htmlIdx, htmlIdx + 1000)
    );
    if (cdataMatch) {
      console.log("\\nContent inside Code macro CDATA:");
      console.log(cdataMatch[1]);
    }
  }

  // ── Step 7: Apply change ──
  if (opts.dryRun) {
    console.log("\\n── DRY RUN ── No changes applied.");
    log("Run with --live to apply the change");
  } else {
    log("\\n── APPLYING CHANGE TO CLOUD ──");
    
    const currentVersion = cloudPage.version?.number || 1;
    const pageTitle = cloudPage.title || page.title;

    log(`Updating Cloud page ${cloudPage.id} (version ${currentVersion} -> ${currentVersion + 1})...`);

    const result = await cloudClient.updatePageContent(
      cloudPage.id,
      pageTitle,
      newBody,
      currentVersion,
    );

    if (result.success) {
      log("\\nSUCCESS: Cloud page updated!");
      log(`Check it: ${process.env.CLOUD_BASE_URL.replace("/wiki", "")}/wiki/pages/${cloudPage.id}`);

      // Verify
      log("\\nVerifying...");
      const verifyPage = await cloudClient.getPageContent(cloudPage.id);
      const verifyBody = verifyPage.body?.storage?.value;
      
      if (verifyBody && verifyBody.includes('<ac:structured-macro ac:name="code"')) {
        console.log("✓ Code macro present in Cloud page");
        
        // Check for CSS content
        const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(verifyBody);
        if (cdataMatch && cdataMatch[1].includes("<style>")) {
          console.log("✓ <style> tag found inside CDATA");
        }
      } else {
        console.log("✗ Code macro not found in verification");
      }
    } else {
      log(`FAILED: ${result.error}`);
    }
  }

  // Final stats
  const dcStats = dcClient.getStats();
  const cloudStats = cloudClient.getStats();
  console.log("\\n" + "─".repeat(70));
  log(`DC API:    ${dcStats.requestCount} requests, ${dcStats.errorCount} errors`);
  log(`Cloud API: ${cloudStats.requestCount} requests, ${cloudStats.errorCount} errors`);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});