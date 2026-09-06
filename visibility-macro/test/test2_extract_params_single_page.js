#!/usr/bin/env node
/**
 * Test 2: Fetch a single Cloud page + its DC counterpart, extract the
 * visibility macros from both, and print the parameters side by side.
 *
 * Usage:
 *   node test/test2_extract_params_single_page.js [CLOUD_PAGE_ID]
 *
 * Default page ID: 123456789 (Sample Page WIP, DOCS space).
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const VisibilityMacroProcessor = require("../src/visibilityMacroProcessor");

(async () => {
  const cloudPageId = process.argv[2] || "123456789";

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

  const processor = new VisibilityMacroProcessor(dc, cloud, null, null, {
    macroNames: ["show-if", "hide-if"],
  });

  console.log(`Fetching Cloud page ${cloudPageId}...`);
  const cloudPage = await cloud.getPageContent(cloudPageId);
  console.log(`  Title: ${cloudPage.title}`);
  console.log(`  Space: ${cloudPage.space?.key}`);
  console.log(`  Version: ${cloudPage.version?.number}`);

  const cloudBody = cloudPage.body?.storage?.value || "";
  const cloudMacros = processor.extractVisibilityMacros(cloudBody);
  console.log(`\nCloud macros found: ${cloudMacros.length}`);
  cloudMacros.forEach((m, i) => {
    console.log(`  [${i}] ${m.macroName}  params=${JSON.stringify(m.params)}`);
  });

  // DC lookup by space + title
  const spaceKey = cloudPage.space?.key;
  const title = cloudPage.title;
  console.log(`\nLooking up DC counterpart in space ${spaceKey} by title "${title}"...`);
  let dcPage = null;
  await dc.searchContentByCql(
    `space = "${spaceKey}" AND title = "${title.replace(/"/g, '\\"')}" AND type = page`,
    "body.storage,version",
    async (results) => {
      if (results.length > 0) {
        dcPage = results[0];
        return false;
      }
    },
  );

  if (!dcPage) {
    console.log("  DC page not found.");
    return;
  }
  console.log(`  DC page id: ${dcPage.id}, version: ${dcPage.version?.number}`);
  const dcBody = dcPage.body?.storage?.value || "";
  const dcMacros = processor.extractVisibilityMacros(dcBody);
  console.log(`\nDC macros found: ${dcMacros.length}`);
  dcMacros.forEach((m, i) => {
    console.log(`  [${i}] ${m.macroName}  params=${JSON.stringify(m.params)}`);
  });
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
