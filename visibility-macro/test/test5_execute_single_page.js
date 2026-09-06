#!/usr/bin/env node
/**
 * Test 5: Real execute on a SINGLE Cloud page. Builds a one-page plan
 * (uses the processor's planner against the explicit Cloud page) and
 * runs the executor against it. Writes a real update.
 *
 * Usage:
 *   node test/test5_execute_single_page.js [CLOUD_PAGE_ID] [SPACE_KEY]
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
  const resolver = new IdentityResolver(cloud, { cacheDir: logDir, log: console.log });

  const processor = new VisibilityMacroProcessor(dc, cloud, planManager, resolver, {
    dryRun: false,
    spaceKeys: [spaceKey],
    limit: 1,
    macroNames: ["show-if", "hide-if"],
    cloudGroupsParamName: "group",
    log: console.log,
  });

  console.log(`Fetching Cloud page ${cloudPageId} (${spaceKey})...`);
  const cloudPage = await cloud.getPageContent(cloudPageId);
  console.log(`  Title: ${cloudPage.title}, version: ${cloudPage.version?.number}`);

  planManager.createPlan(`test5_${Date.now()}`);
  const planned = await processor._planCloudPage(cloudPage);
  if (!planned) {
    console.log("\nNothing to plan for this page.");
    return;
  }
  planManager.savePlan();
  console.log(`\nPlan saved: ${planManager.planFilePath}`);

  console.log("\nExecuting (REAL UPDATE)...");
  await processor.executePlan();
  planManager.savePlan();

  const after = await cloud.getPageContent(cloudPageId);
  console.log(`\nAfter update — version: ${after.version?.number}`);
  const stats = processor.getStats();
  console.log(`Stats: updated=${stats.pagesUpdated}, failed=${stats.pagesFailed}, skipped=${stats.pagesSkipped}, unresolved=${stats.pagesUnresolved}`);
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
