#!/usr/bin/env node

/**
 * Online: post-run verification. Counts how many pages still match the
 * old (deck/card) discovery CQL, and how many match the target
 * (tab-group/tab) CQL, scoped to a space (or --all).
 *
 * Usage:  node test/test6_residual_zero_after_run.js <SPACE_KEY>
 *         node test/test6_residual_zero_after_run.js --all
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

async function countCql(cloud, cql) {
  let n = 0;
  await cloud.searchContentByCql(cql, "version", async (results) => { n += results.length; });
  return n;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node test/test6_residual_zero_after_run.js <SPACE_KEY>|--all");
    process.exit(1);
  }
  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  const scope = arg === "--all" ? "" : `space = "${arg}" AND `;
  const residualCql = `${scope}macro in ("deck","card") AND type = page`;
  const landedCql = `${scope}macro in ("tab-group","tab") AND type = page`;

  const residual = await countCql(cloud, residualCql);
  const landed = await countCql(cloud, landedCql);

  console.log(`Residual deck/card pages:  ${residual}   (CQL: ${residualCql})`);
  console.log(`Landed tab-group/tab pages: ${landed}   (CQL: ${landedCql})`);
  if (residual === 0) {
    console.log("\n✓ Zero residual — full conversion (or no candidates left to convert).");
  } else {
    console.log(`\n  ${residual} page(s) still match the old shape; if any are not 'ambiguous-card' skips, investigate.`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
