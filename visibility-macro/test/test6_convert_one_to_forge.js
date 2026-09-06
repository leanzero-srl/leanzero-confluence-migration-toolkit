#!/usr/bin/env node
/**
 * Test 6: Patch a single legacy show-if bodiedExtension into the Forge
 * ecosystem extension format (the only one Cloud actually renders), via
 * atlas_doc_format. Uses the user's already-converted macro on the same
 * page as a template (steals its extensionKey / extensionId / appId).
 *
 * Usage:
 *   node test/test6_convert_one_to_forge.js [CLOUD_PAGE_ID] [INDEX]
 *
 * Defaults: CLOUD_PAGE_ID=123456789, INDEX=0 (first legacy macro found).
 */

const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

(async () => {
  const cloudPageId = process.argv[2] || "123456789";
  const targetIndex = parseInt(process.argv[3] || "0", 10);

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  // Fetch with ADF
  const page = await cloud.makeRequest(
    "GET",
    `/rest/api/content/${cloudPageId}?expand=body.atlas_doc_format,version,space`,
  );
  console.log(`Page: ${page.title} v${page.version.number}`);
  const adf = JSON.parse(page.body.atlas_doc_format.value);

  // Find the user's already-converted Forge node (template) and the legacy ones
  const forgeNodes = [];
  const legacyNodes = [];
  function walk(node, parent, idx) {
    if (!node || typeof node !== "object") return;
    if (node.type === "bodiedExtension" && node.attrs) {
      const ek = node.attrs.extensionKey || "";
      const et = node.attrs.extensionType || "";
      const isShowIf = ek === "show-if" || ek.endsWith("/show-if");
      if (isShowIf && et === "com.atlassian.ecosystem") {
        forgeNodes.push({ node, parent, idx });
      } else if (isShowIf && et === "com.atlassian.confluence.macro.core") {
        legacyNodes.push({ node, parent, idx });
      }
    }
    if (Array.isArray(node.content)) {
      node.content.forEach((c, i) => walk(c, node, i));
    }
  }
  walk(adf, null, -1);

  console.log(`Forge ecosystem nodes found: ${forgeNodes.length}`);
  console.log(`Legacy macro.core show-if nodes: ${legacyNodes.length}`);
  if (forgeNodes.length === 0) {
    console.error("No Forge template found on this page. Cannot proceed.");
    process.exit(2);
  }
  if (legacyNodes.length === 0) {
    console.log("No legacy macros to convert.");
    return;
  }
  if (targetIndex >= legacyNodes.length) {
    console.error(`INDEX ${targetIndex} out of range; only ${legacyNodes.length} legacy nodes`);
    process.exit(2);
  }

  const template = forgeNodes[0].node.attrs;
  const target = legacyNodes[targetIndex].node;

  // Build new attrs cloned from template, but keep the target's macro params,
  // localId, and macroId so the body content stays glued to the correct macro.
  const targetParams = (target.attrs && target.attrs.parameters) || {};
  const targetMacroId =
    targetParams?.macroMetadata?.macroId?.value || target.attrs?.localId;
  const targetLocalId = target.attrs?.localId || targetMacroId;
  const targetLayout = target.attrs?.layout || template.layout || "default";

  // The Forge app wants raw group NAMES (not IDs). The current value may
  // be UUIDs (we previously wrote IDs). For this test, force-set names.
  const groupValue = process.env.TEST_GROUP_VALUE || "staff, wiki_external";

  const newAttrs = {
    layout: targetLayout,
    extensionType: "com.atlassian.ecosystem",
    extensionKey: template.extensionKey,
    text: template.text || "Visibility - Show if",
    parameters: {
      guestParams: { group: groupValue },
      layout: "bodiedExtension",
      forgeEnvironment: template.parameters.forgeEnvironment || "PRODUCTION",
      macroParams: { group: { value: groupValue } },
      embeddedMacroContext: template.parameters.embeddedMacroContext,
      macroMetadata: {
        macroId: { value: targetMacroId },
        schemaVersion: { value: "1" },
        title: "show-if",
      },
      localId: targetLocalId,
      extensionId: template.parameters.extensionId,
      render: "native",
      extensionTitle: template.extensionTitle || "Visibility - Show if",
    },
    localId: target.attrs?.localId || crypto.randomUUID(),
  };

  // Mutate in-place
  target.attrs = newAttrs;
  // Note: we keep target.content (the rich body) as-is.

  console.log(`\nConverted legacy macro [${targetIndex}] -> Forge format with group="${groupValue}"`);

  // PUT the page back via v1 with atlas_doc_format
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
      message: "Convert legacy show-if to Forge ecosystem format",
    },
  };

  const result = await cloud.makeRequest(
    "PUT",
    `/rest/api/content/${cloudPageId}`,
    putBody,
  );
  console.log(`PUT result: version now ${result.version?.number}`);
})().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
