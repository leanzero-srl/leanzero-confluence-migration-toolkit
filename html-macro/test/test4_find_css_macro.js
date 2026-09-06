#!/usr/bin/env node

/**
 * TEST 4: Find CSS macros across all spaces in DC (with proper pagination)
 *
 * Scans all Confluence Data Center spaces looking for pages with CSS macros.
 * Uses proper pagination to handle hundreds of thousands of pages.
 *
 * Usage:
 *   node test/test4_find_css_macro.js                    # Scan all spaces until CSS found
 *   node test/test4_find_css_macro.js --space PROJ       # Search specific space only
 *   node test/test4_find_css_macro.js --limit 10         # Max results per CQL search
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { space: null, limit: 10 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--space" && args[i + 1]) opts.space = args[++i];
    if (args[i] === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i], 10) || 10;
  }
  return opts;
}

/**
 * Extract CSS macros from storage format XML
 */
function extractCssMacros(storageBody) {
  if (!storageBody) return [];

  const macros = [];
  
  // Pattern: <ac:structured-macro ac:name="css"...><ac:plain-text-body><![CDATA[...]]></ac:plain-text-body></ac:structured-macro>
  const cdataRegex = /<ac:structured-macro[^>]*?ac:name\s*=\s*"css"[^>]*?>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi;
  
  let match;
  while ((match = cdataRegex.exec(storageBody)) !== null) {
    macros.push({ content: match[1], fullMatch: match[0] });
  }

  // Fallback for plain text body (no CDATA)
  if (macros.length === 0) {
    const plainRegex = /<ac:structured-macro[^>]*?ac:name\s*=\s*"css"[^>]*?>[\s\S]*?<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi;
    while ((match = plainRegex.exec(storageBody)) !== null) {
      macros.push({ content: match[1], fullMatch: match[0] });
    }
  }

  return macros;
}

function printCssContent(label, cssContent, maxLen) {
  const max = maxLen || 400;
  console.log(`  ${label} (${cssContent.length} chars):`);
  console.log("  ┌" + "─".repeat(60));
  const lines = cssContent.substring(0, max).split("\n");
  for (const line of lines) {
    console.log("  │ " + line);
  }
  if (cssContent.length > max) {
    console.log("  │ ...(truncated)");
  }
  console.log("  └" + "─".repeat(60));
}

async function main() {
  const opts = parseArgs();

  log("=== TEST 4: Find CSS macros in DC ===");
  log(`DC URL: ${process.env.DC_BASE_URL}`);
  if (opts.space) log(`Space filter: ${opts.space}`);
  log(`Limit per CQL search: ${opts.limit}`);
  log("");

  const dcClient = new DatacenterConfluenceClient(
    process.env.DC_BASE_URL,
    process.env.DC_USERNAME,
    process.env.DC_PASSWORD,
  );

  // Test connection
  log("Testing DC connection...");
  const ok = await dcClient.testConnection();
  if (!ok) {
    log("FAILED: Cannot connect to Confluence DC.");
    process.exit(1);
  }
  log("DC connection: OK\n");

  let cssMacroFound = false;
  let totalPagesScanned = 0;

  // Get spaces to scan
  const targetSpaces = opts.space 
    ? opts.space.split(",").map(s => ({ key: s.trim(), name: s.trim() }))
    : await dcClient.getAllSpaces();

  log(`Checking ${targetSpaces.length} space(s) for CSS macros...\n`);

  for (let i = 0; i < targetSpaces.length && !cssMacroFound; i++) {
    const space = targetSpaces[i];
    log(`[${i + 1}/${targetSpaces.length}] Scanning space: ${space.key}...`);

    const cql = `space = "${space.key}" AND macro = "css" AND type = page`;
    log(`  CQL: ${cql}`);

    // Use proper pagination via searchContentByCql
    try {
      await dcClient.searchContentByCql(cql, "body.storage,version,space", async (results) => {
        for (const page of results) {
          totalPagesScanned++;
          
          if (!page.body?.storage?.value) continue;

          const cssMacros = extractCssMacros(page.body.storage.value);
          
          if (cssMacros.length > 0) {
            cssMacroFound = true;
            
            console.log("\n" + "═".repeat(70));
            console.log("FOUND CSS MACRO!");
            console.log("═".repeat(70));
            console.log(`  Space:       ${space.key} (${space.name})`);
            console.log(`  Page ID:     ${page.id}`);
            console.log(`  Title:       ${page.title}`);
            console.log(`  Version:     ${page.version?.number || "N/A"}`);
            console.log(`  DC URL:      ${process.env.DC_BASE_URL}/pages/viewpage.action?pageId=${page.id}`);
            console.log(`  CSS Macros:  ${cssMacros.length}`);
            console.log("");

            for (let j = 0; j < cssMacros.length; j++) {
              console.log(`  --- CSS Macro #${j + 1} ---`);
              printCssContent("CSS Content", cssMacros[j].content);
              console.log("");
            }

            return false; // Stop pagination
          }
        }
        
        if (results.length > 0) {
          log(`  Checked ${results.length} pages, total scanned: ${totalPagesScanned}`);
        }
        
        return null; // Continue pagination
      });
    } catch (error) {
      log(`  ERROR during CQL search: ${error.message}`);
    }
    
    if (!cssMacroFound) {
      log(`  Space ${space.key}: No CSS macros found`);
    }
  }

  console.log("\n" + "═".repeat(70));
  
  if (cssMacroFound) {
    log("✓ CSS macro(s) found! Check details above.");
  } else {
    log("✗ No CSS macros found after scanning all pages.");
    log(`  Total pages scanned: ${totalPagesScanned}`);
    log(`  Spaces checked: ${targetSpaces.length}`);
    log("");
    log("Note: Pages with <style> tags inside HTML macros are NOT CSS macros.");
    log("They use ac:name=\"html\" not ac:name=\"css\"");
  }

  const dcStats = dcClient.getStats();
  log(`\nAPI stats: ${dcStats.requestCount} requests, ${dcStats.errorCount} errors`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});