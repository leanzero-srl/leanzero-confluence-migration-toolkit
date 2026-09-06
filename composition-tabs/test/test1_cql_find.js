#!/usr/bin/env node

/**
 * Online: CQL discovery smoke test.
 *
 * Usage:  node test/test1_cql_find.js <SPACE_KEY>
 *         node test/test1_cql_find.js --all
 *
 * Prints the first 50 candidate pages found via the discovery CQL.
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node test/test1_cql_find.js <SPACE_KEY>|--all");
    process.exit(1);
  }
  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  const cql = arg === "--all"
    ? `macro in ("deck","card") AND type = page ORDER BY id`
    : `space = "${arg}" AND macro in ("deck","card") AND type = page ORDER BY id`;
  console.log(`CQL: ${cql}\n`);

  let count = 0;
  await cloud.searchContentByCql(cql, "version,space", async (results) => {
    for (const r of results) {
      count++;
      console.log(`  ${count}. ${r.id}  [${r.space?.key || "?"}]  ${r.title}`);
      if (count >= 50) return false;
    }
  });
  console.log(`\nTotal: ${count}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
