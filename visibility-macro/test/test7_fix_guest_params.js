#!/usr/bin/env node
/**
 * Test 7: Patch every Forge show-if macro on a page to populate
 * guestParams.groupIds (the field the new editor reads). Names are
 * pulled from macroParams.group.value (which we keep as raw names),
 * resolved against the Cloud group picker.
 *
 * Usage: node test/test7_fix_guest_params.js [CLOUD_PAGE_ID]
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const IdentityResolver = require("../src/identityResolver");

(async () => {
  const cloudPageId = process.argv[2] || "123456789";

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );
  const resolver = new IdentityResolver(cloud, {
    cacheDir: path.resolve(__dirname, "../logs"),
    log: console.log,
  });

  const page = await cloud.makeRequest(
    "GET",
    `/rest/api/content/${cloudPageId}?expand=body.atlas_doc_format,version`,
  );
  console.log(`Page v${page.version.number}`);
  const adf = JSON.parse(page.body.atlas_doc_format.value);

  const targets = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "bodiedExtension" && node.attrs) {
      const ek = node.attrs.extensionKey || "";
      const isShowIf = ek === "show-if" || ek.endsWith("/show-if");
      if (isShowIf && node.attrs.extensionType === "com.atlassian.ecosystem") {
        targets.push(node);
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(adf);

  console.log(`Forge show-if nodes: ${targets.length}`);
  let mutated = 0;
  for (const node of targets) {
    const params = node.attrs.parameters;
    const namesRaw = params?.macroParams?.group?.value || "";
    const names = namesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const ids = [];
    const unresolved = [];
    for (const name of names) {
      const id = await resolver.resolveGroup(name);
      if (id) ids.push(id);
      else unresolved.push(name);
    }
    const idsStr = ids.join(",");
    if (!params.guestParams) params.guestParams = {};
    const before = params.guestParams.groupIds || "";
    params.guestParams.groupIds = idsStr;
    if (params.guestParams.users === undefined) params.guestParams.users = "";
    if (params.guestParams.cwStatus === undefined) params.guestParams.cwStatus = "";
    if (params.guestParams.matchUsing === undefined) params.guestParams.matchUsing = "any";
    // Also remove any legacy "group" key in guestParams to avoid duplicate signal
    if (params.guestParams.group !== undefined) delete params.guestParams.group;

    console.log(`  macroId=${params.macroMetadata?.macroId?.value}: names="${namesRaw}" -> ids="${idsStr}"  (was guestParams.groupIds="${before}")  unresolved=${JSON.stringify(unresolved)}`);
    if (idsStr !== before) mutated++;
  }

  if (mutated === 0) {
    console.log("Nothing to update.");
    return;
  }

  const putBody = {
    id: String(cloudPageId),
    type: page.type || "page",
    title: page.title,
    body: {
      atlas_doc_format: {
        value: JSON.stringify(adf),
        representation: "atlas_doc_format",
      },
    },
    version: {
      number: page.version.number + 1,
      message: "Populate Forge show-if guestParams.groupIds",
    },
  };
  const result = await cloud.makeRequest("PUT", `/rest/api/content/${cloudPageId}`, putBody);
  console.log(`PUT ok, version now ${result.version?.number}`);
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
