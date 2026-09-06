#!/usr/bin/env node

/**
 * Online: fetch one page's storage XHTML, run findCandidateMacros, and
 * print every detected deck/card instance with its parent and decision.
 *
 * Usage:  node test/test2_extract_macros_single_page.js <CLOUD_PAGE_ID>
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const CompositionMacroProcessor = require("../src/compositionMacroProcessor");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node test/test2_extract_macros_single_page.js <CLOUD_PAGE_ID>");
    process.exit(1);
  }
  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );
  const sp = await cloud.getPageStorage(id);
  const storage = sp.body?.storage?.value || "";
  console.log(`Page: ${sp.title} (id=${sp.id}, version=${sp.version?.number}, ${storage.length} chars)\n`);

  const proc = new CompositionMacroProcessor({ log: () => {} });
  const instances = proc.findCandidateMacros(storage);
  console.log(`Detected ${instances.length} candidate macro instance(s):`);
  for (const inst of instances) {
    const decision = proc.shouldRewrite(inst);
    console.log(`  - name=${inst.name}  id=${inst.macroId}  parent=${inst.parent_name}  ` +
      `params=[${Object.keys(inst.params).join(",")}]  ` +
      `selfClose=${inst.selfClose}  decision=${decision.rewrite}/${decision.reason}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
