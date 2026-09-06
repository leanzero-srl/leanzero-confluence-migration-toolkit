#!/usr/bin/env node
/**
 * Test 1: Verify Cloud CQL search returns pages containing show-if / hide-if macros.
 *
 * Usage:
 *   node test/test1_cql_find_visibility_macros.js [SPACE_KEY]
 *
 * Default space key: DOCS (the DOCS sandbox example).
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

(async () => {
  const spaceKey = process.argv[2] || "DOCS";
  const macros = ["show-if", "hide-if"];
  const cql = `space = "${spaceKey}" AND macro in (${macros.map((m) => `"${m}"`).join(",")}) AND type = page`;

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  console.log(`CQL: ${cql}`);

  let count = 0;
  const sampled = [];
  await cloud.searchContentByCql(cql, "version,space", async (results) => {
    for (const p of results) {
      count++;
      if (sampled.length < 10) {
        sampled.push({ id: p.id, title: p.title, space: p.space?.key });
      }
    }
  });

  console.log(`\nFound ${count} pages with visibility macros in space ${spaceKey}.`);
  console.log("First 10 sample pages:");
  for (const p of sampled) {
    console.log(`  - ${p.id}  ${p.space}/${p.title}`);
  }
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
