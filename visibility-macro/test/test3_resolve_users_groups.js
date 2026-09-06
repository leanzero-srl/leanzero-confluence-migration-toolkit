#!/usr/bin/env node
/**
 * Test 3: Resolve a list of group names and usernames against the Cloud APIs.
 *
 * Usage:
 *   node test/test3_resolve_users_groups.js
 *     [--groups "staff,wiki_external"] [--users "user1,user2"]
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const IdentityResolver = require("../src/identityResolver");

function parseArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const groupList = parseArg("groups", "staff,wiki_external");
  const userList = parseArg("users", "");

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  const resolver = new IdentityResolver(cloud, {
    cacheDir: path.resolve(__dirname, "../logs"),
  });

  console.log(`Resolving groups: ${groupList}`);
  for (const g of groupList.split(",").map((s) => s.trim()).filter(Boolean)) {
    const id = await resolver.resolveGroup(g);
    console.log(`  ${g} -> ${id || "<NOT FOUND>"}`);
  }

  if (userList) {
    console.log(`\nResolving users: ${userList}`);
    for (const u of userList.split(",").map((s) => s.trim()).filter(Boolean)) {
      const id = await resolver.resolveUser(u);
      console.log(`  ${u} -> ${id || "<NOT FOUND>"}`);
    }
  }

  const stats = resolver.getStats();
  console.log(`\nResolver stats: ${JSON.stringify(stats)}`);
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
