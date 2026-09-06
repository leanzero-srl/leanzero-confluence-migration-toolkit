#!/usr/bin/env node

/**
 * DEBUG TEST: End-to-end macro replacement with verbose logging
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
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

  log("=== DEBUG TEST: HTML macro replacement ===");

  // DC page ID from earlier tests
  const dcPageId = "122815826";
  const cloudPageId = "56356833";

  // ── Get DC content ──
  log(`\\nStep 1: Getting DC page ${dcPageId}...`);
  const dcPage = await dcClient.makeRequest("GET", `/rest/api/content/${dcPageId}?expand=body.storage,version,space`);
  const dcBody = dcPage.body && dcPage.body.storage && dcPage.body.storage.value;
  log(`DC page body length: ${dcBody ? dcBody.length : 0} chars`);

  // Find HTML macros in DC
  function extractHtmlMacros(storageBody) {
    if (!storageBody) return [];
    const macros = [];
    
    // Pattern for CDATA-wrapped macros
    const cdataRegex = /<ac:structured-macro[^>]*?ac:name\s*=\s*"html"[^>]*?>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/g;
    let match;
    while ((match = cdataRegex.exec(storageBody)) !== null) {
      macros.push({
        index: macros.length,
        content: match[1],
        fullMatch: match[0]
      });
    }
    
    return macros;
  }

  const dcHtmlMacros = extractHtmlMacros(dcBody);
  log(`DC HTML macros found: ${dcHtmlMacros.length}`);
  
  for (let i = 0; i < dcHtmlMacros.length; i++) {
    console.log(`\\n=== DC HTML Macro #${i + 1} ===`);
    console.log("Length:", dcHtmlMacros[i].content.length, "chars");
    console.log("Content:");
    console.log(dcHtmlMacros[i].content.substring(0, 500));
  }

  // ── Get Cloud content BEFORE ──
  log(`\\nStep 2: Getting Cloud page ${cloudPageId} (BEFORE)...`);
  const cloudPageBefore = await cloudClient.makeRequest("GET", `/api/v2/pages/${cloudPageId}?body-format=storage`);
  const cloudBodyBefore = cloudPageBefore.body && cloudPageBefore.body.storage && cloudPageBefore.body.storage.value;
  log(`Cloud page body length (BEFORE): ${cloudBodyBefore ? cloudBodyBefore.length : 0} chars`);

  // Find HTML macros in Cloud
  const cloudHtmlMacrosBefore = extractHtmlMacros(cloudBodyBefore);
  log(`Cloud HTML macros found (BEFORE): ${cloudHtmlMacrosBefore.length}`);

  for (let i = 0; i < cloudHtmlMacrosBefore.length; i++) {
    console.log(`\\n=== Cloud HTML Macro #${i + 1} BEFORE ===`);
    console.log("Length:", cloudHtmlMacrosBefore[i].content.length, "chars");
    console.log("Full match length:", cloudHtmlMacrosBefore[i].fullMatch.length, "chars");
    console.log("Content:");
    console.log(cloudHtmlMacrosBefore[i].content.substring(0, 500));
  }

  // ── Perform replacement manually ──
  log("\\nStep 3: Performing replacement (raw mode)...");

  let newBody = cloudBodyBefore;
  let replacementsMade = 0;

  for (let i = dcHtmlMacros.length - 1; i >= 0; i--) {
    const dcMacroContent = dcHtmlMacros[i].content;
    const cloudFullMatch = cloudHtmlMacrosBefore[i] ? cloudHtmlMacrosBefore[i].fullMatch : null;
    
    console.log(`\\n--- Processing macro ${i + 1} ---`);
    console.log("DC content to insert:", dcMacroContent.substring(0, 100) + "...");
    if (cloudFullMatch) {
      console.log("Cloud full match found:", cloudFullMatch.substring(0, 100) + "...");
      
      // Replace
      const beforeLength = newBody.length;
      newBody = newBody.replace(cloudFullMatch, dcMacroContent);
      console.log("After replacement, body length changed from", beforeLength, "to", newBody.length);
      
      replacementsMade++;
    } else {
      console.log("WARNING: No matching Cloud macro block found!");
    }
  }

  log(`Replacements made: ${replacementsMade}`);

  // ── Show result ──
  log("\\nStep 4: Checking replacement result...");
  console.log("\\n=== NEW BODY (first 1000 chars) ===");
  console.log(newBody.substring(0, 1000));
  
  if (newBody.includes("<style>")) {
    const styleIdx = newBody.indexOf("<style>");
    console.log("\\nFOUND <style> tag at position:", styleIdx);
    console.log("Context around it:");
    console.log(newBody.substring(Math.max(0, styleIdx - 50), Math.min(newBody.length, styleIdx + 200)));
  } else {
    console.log("\\nNO <style> tag found in new body!");
  }

  // ── PUT to Cloud ──
  log("\\nStep 5: Updating Cloud page...");
  
  const currentVersion = cloudPageBefore.version ? cloudPageBefore.version.number : 1;
  const pageTitle = cloudPageBefore.title || "Test Page";
  
  // Try using raw body directly
  console.log("\\n--- Sending PUT request with body ---");
  console.log("Body length:", newBody.length);
  console.log("Has style tag:", newBody.includes("<style>") ? "YES" : "NO");
  
  const updateResponse = await cloudClient.makeRequest("PUT", `/api/v2/pages/${cloudPageId}`, {
    id: cloudPageId,
    status: "current",
    title: pageTitle,
    body: {
      representation: "storage",
      value: newBody
    },
    version: {
      number: currentVersion + 1,
      message: "Test macro replacement"
    }
  });
  
  console.log("\\n--- Update Response ---");
  if (updateResponse) {
    console.log(JSON.stringify(updateResponse, null, 2).substring(0, 1000));
  } else {
    console.log("Empty response body (204 No Content is normal)");
  }

  log("Update response:", JSON.stringify(updateResponse, null, 2).substring(0, 500));

  // ── Verify ──
  log("\\nStep 6: Verifying update...");
  const cloudPageAfter = await cloudClient.makeRequest("GET", `/api/v2/pages/${cloudPageId}?body-format=storage`);
  const cloudBodyAfter = cloudPageAfter.body && cloudPageAfter.body.storage && cloudPageAfter.body.storage.value;
  
  console.log("\\n=== Cloud body AFTER (first 1000 chars) ===");
  console.log(cloudBodyAfter.substring(0, 1000));
  
  if (cloudBodyAfter.includes("<style>")) {
    const styleIdx = cloudBodyAfter.indexOf("<style>");
    console.log("\\n✓ <style> tag FOUND at position:", styleIdx);
    console.log("Context:");
    console.log(cloudBodyAfter.substring(Math.max(0, styleIdx - 50), Math.min(cloudBodyAfter.length, styleIdx + 200)));
  } else {
    console.log("\\n✗ NO <style> tag found in Cloud body after update!");
  }

  // Stats
  log("\\nStep 7: Final stats...");
  const dcStats = dcClient.getStats();
  const cloudStats = cloudClient.getStats();
  console.log(`\\nDC API requests: ${dcStats.requestCount}, errors: ${dcStats.errorCount}`);
  console.log(`Cloud API requests: ${cloudStats.requestCount}, errors: ${cloudStats.errorCount}`);

  // Compare
  log("\\nFinal comparison...");
  console.log("Before length:", cloudBodyBefore.length);
  console.log("After length:", cloudBodyAfter.length);
  console.log("Match expected new body:", cloudBodyAfter === newBody ? "YES" : "NO (body was modified)");
}

main().catch((e) => {
  console.error("\\nFatal error:", e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});