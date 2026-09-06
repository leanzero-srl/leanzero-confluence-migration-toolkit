#!/usr/bin/env node
/**
 * Test 4: End-to-end dry-run on a single Cloud page.
 * Shows current macros, the source params chosen, the resolved IDs,
 * and the diff between the current and proposed storage body.
 *
 * Usage:
 *   node test/test4_dry_run_single_page.js [CLOUD_PAGE_ID] [SPACE_KEY]
 *
 * Defaults: CLOUD_PAGE_ID=123456789, SPACE_KEY=DOCS.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const PlanManager = require("../src/planManager");
const IdentityResolver = require("../src/identityResolver");
const VisibilityMacroProcessor = require("../src/visibilityMacroProcessor");

(async () => {
  const cloudPageId = process.argv[2] || "123456789";
  const spaceKey = process.argv[3] || "DOCS";

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );
  const dc = new DatacenterConfluenceClient(
    process.env.DC_BASE_URL,
    process.env.DC_USERNAME,
    process.env.DC_PASSWORD,
  );
  const logDir = path.resolve(__dirname, "../logs");
  const planManager = new PlanManager(logDir, console.log);
  const resolver = new IdentityResolver(cloud, { cacheDir: logDir });

  const processor = new VisibilityMacroProcessor(dc, cloud, planManager, resolver, {
    dryRun: true,
    spaceKeys: [spaceKey],
    limit: 1,
    macroNames: ["show-if", "hide-if"],
    cloudGroupsParamName: "groups",
    log: console.log,
  });

  // Build a one-page plan by directly invoking _planCloudPage on the target
  console.log(`Fetching Cloud page ${cloudPageId}...`);
  const cloudPage = await cloud.getPageContent(cloudPageId);

  planManager.createPlan(`test4_${Date.now()}`);
  const planned = await processor._planCloudPage(cloudPage);
  if (!planned) {
    console.log("\nNothing to plan for this page (no change required, or no DC counterpart).");
    return;
  }

  // Print plan entry
  const entry = planManager.plan.pages[cloudPageId];
  console.log(`\nPlan entry for page ${cloudPageId}:`);
  console.log(JSON.stringify(entry, null, 2));

  // Show what the new body would look like (preview only — does NOT write)
  const fresh = await cloud.getPageContent(cloudPageId);
  const body = fresh.body?.storage?.value || "";
  const cloudMacros = processor.extractVisibilityMacros(body);
  let newBody = body;
  for (let i = cloudMacros.length - 1; i >= 0; i--) {
    const cm = cloudMacros[i];
    const planned = entry.macros[i];
    if (!planned) continue;
    if (planned.unresolvedUsers.length > 0 || planned.unresolvedGroups.length > 0) continue;
    let macroXml = cm.fullMatch;
    const writeGroupParam = planned.groupParamName || "groups";
    if (planned.newParams.users || (planned.cloudParams && planned.cloudParams.users)) {
      macroXml = processor.setMacroParam(macroXml, "users", planned.newParams.users || "");
    }
    if (planned.newParams.groups || (planned.cloudParams && planned.cloudParams.groups)) {
      macroXml = processor.setMacroParam(macroXml, writeGroupParam, planned.newParams.groups || "");
    }
    newBody = newBody.substring(0, cm.start) + macroXml + newBody.substring(cm.end);
  }

  console.log(`\nDIFF preview (first ${Math.min(2000, body.length)} chars):`);
  console.log("\n--- Current Cloud body (excerpt) ---");
  console.log(body.substring(0, 2000));
  console.log("\n--- Proposed body (excerpt) ---");
  console.log(newBody.substring(0, 2000));
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
