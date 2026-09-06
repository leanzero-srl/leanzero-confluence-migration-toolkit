require("dotenv").config({ path: ".env" });
const fs = require("fs");
const DC = require("./src/datacenterConfluenceClient");
const Cloud = require("./src/cloudConfluenceClient");
const VMP = require("./src/visibilityMacroProcessor");

const SAMPLE_SIZE = parseInt(process.argv[2] || "150", 10);
const SEED = parseInt(process.argv[3] || "42", 10);

// Tiny seedable PRNG so reruns are deterministic
function mulberry32(a) {
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

const dc = new DC(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD, { pat: process.env.DC_PAT });
const cloud = new Cloud(process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);
const proc = new VMP(dc, cloud, null, null, { macroNames: ["show-if", "hide-if"] });

const KNOWN_GROUP_PARAMS = new Set(["group", "groups", "user-groups"]);
const KNOWN_USER_PARAMS = new Set(["users", "user"]);

function rawCountAllowedMacros(body) {
  const re = /<ac:structured-macro\b[^>]+ac:name="(show-if|hide-if)"/g;
  let n = 0;
  while (re.exec(body) !== null) n++;
  return n;
}

function rawAllParamNames(body) {
  // Collect every <ac:parameter ac:name="X"> name found inside any show-if/hide-if macro
  // (depth-unaware — used to detect "param name we don't check")
  const allowed = new Set(["show-if", "hide-if"]);
  const openTag = /<ac:structured-macro\b([^>]*)>/g;
  const closeTag = "</ac:structured-macro>";
  const paramRe = /<ac:parameter\b[^>]*ac:name="([^"]+)"[^>]*>([\s\S]*?)<\/ac:parameter>/g;
  const found = [];
  let match;
  while ((match = openTag.exec(body)) !== null) {
    const attrs = match[1];
    const nameMatch = attrs.match(/ac:name="([^"]+)"/);
    if (!nameMatch || !allowed.has(nameMatch[1])) continue;
    const start = match.index;
    let depth = 1, cursor = openTag.lastIndex;
    while (depth > 0) {
      const nO = body.indexOf("<ac:structured-macro", cursor);
      const nC = body.indexOf(closeTag, cursor);
      if (nC === -1) break;
      if (nO !== -1 && nO < nC) { depth++; cursor = nO + "<ac:structured-macro".length; }
      else { depth--; cursor = nC + closeTag.length; if (depth === 0) {
        // Capture params at any depth inside this macro (we only care if name was unknown)
        const inner = body.substring(start, cursor);
        paramRe.lastIndex = 0;
        let p, params = {};
        while ((p = paramRe.exec(inner)) !== null) params[p[1]] = (p[2]||"").trim();
        found.push({ name: nameMatch[1], params });
      } }
    }
  }
  return found;
}

(async () => {
  const plan = JSON.parse(fs.readFileSync("logs/plan_1776716711969.json", "utf8"));

  // Build pool of pages where every macro has empty source group AND user names
  // and DC was matched.
  const pool = [];
  for (const [pid, p] of Object.entries(plan.pages)) {
    if (!p.dcPageId || !p.macros || !p.macros.length) continue;
    const allEmpty = p.macros.every(m => !m.sourceGroupNames && !m.sourceUserNames);
    if (allEmpty) pool.push(p);
  }
  console.log(`Pool of empty-source pages: ${pool.length}`);

  // Random sample
  const sample = [];
  const taken = new Set();
  while (sample.length < Math.min(SAMPLE_SIZE, pool.length)) {
    const idx = Math.floor(rng() * pool.length);
    if (taken.has(idx)) continue;
    taken.add(idx);
    sample.push(pool[idx]);
  }
  console.log(`Sampling ${sample.length} pages (seed=${SEED})\n`);

  const cats = {
    A_nested_misalignment: [],
    B_unrecognized_param: [],
    C_legit_empty: [],
    D_extractor_bug: [],
    E_dc_fetch_failed: [],
  };
  const unknownParamNames = new Map();

  let i = 0;
  for (const p of sample) {
    i++;
    process.stdout.write(`[${i}/${sample.length}] DC=${p.dcPageId} "${p.title.substring(0,50)}" `);
    let dcPage;
    try { dcPage = await dc.getPageContent(p.dcPageId); }
    catch (e) {
      console.log(`-> DC fetch ERR ${e.statusCode||""}`);
      cats.E_dc_fetch_failed.push({ pid: p.cloudPageId, dcId: p.dcPageId, err: e.message.substring(0, 80) });
      continue;
    }
    const body = dcPage.body?.storage?.value || "";
    const rawCount = rawCountAllowedMacros(body);
    const extracted = proc.extractDcParamsFromStorage(body);
    const rawAllMacros = rawAllParamNames(body);

    // A) nested misalignment if raw count > extracted count
    if (rawCount > extracted.length) {
      cats.A_nested_misalignment.push({ pid: p.cloudPageId, dcId: p.dcPageId, title: p.title, cloudMacros: p.macros.length, dcRaw: rawCount, dcExtracted: extracted.length });
      console.log(`-> A nested (raw=${rawCount} extracted=${extracted.length} cloud=${p.macros.length})`);
      continue;
    }

    // Look at all params across all macros (raw, depth-aware on macro boundary but params inside)
    const allParamNames = new Set();
    let anyKnownGroupHasValue = false;
    let anyKnownUserHasValue = false;
    let anyParamAtAll = false;
    for (const m of rawAllMacros) {
      for (const [k, v] of Object.entries(m.params)) {
        anyParamAtAll = true;
        allParamNames.add(k);
        if (KNOWN_GROUP_PARAMS.has(k) && v) anyKnownGroupHasValue = true;
        if (KNOWN_USER_PARAMS.has(k) && v) anyKnownUserHasValue = true;
      }
    }

    if (!anyParamAtAll) {
      cats.C_legit_empty.push({ pid: p.cloudPageId, dcId: p.dcPageId, title: p.title, dcRaw: rawCount });
      console.log(`-> C legit-empty (no params at all in ${rawCount} macro(s))`);
      continue;
    }

    if (anyKnownGroupHasValue || anyKnownUserHasValue) {
      // The script SHOULD have picked these up — extractor bug
      cats.D_extractor_bug.push({ pid: p.cloudPageId, dcId: p.dcPageId, title: p.title, paramNames: [...allParamNames] });
      console.log(`-> D extractor-bug (params=${[...allParamNames].join(",")})`);
      continue;
    }

    // B) Has params but NONE are recognized group/user names
    const unknown = [...allParamNames].filter(n => !KNOWN_GROUP_PARAMS.has(n) && !KNOWN_USER_PARAMS.has(n));
    cats.B_unrecognized_param.push({ pid: p.cloudPageId, dcId: p.dcPageId, title: p.title, paramNames: unknown });
    for (const n of unknown) unknownParamNames.set(n, (unknownParamNames.get(n) || 0) + 1);
    console.log(`-> B unrecognized-param (${unknown.join(",")})`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("CATEGORIZATION SUMMARY");
  console.log("=".repeat(60));
  const total = sample.length;
  for (const [k, arr] of Object.entries(cats)) {
    const pct = ((arr.length/total)*100).toFixed(1);
    console.log(`${k.padEnd(28)} ${String(arr.length).padStart(4)}  (${pct}%)`);
  }
  if (unknownParamNames.size) {
    console.log("\nUnrecognized param names found (B):");
    [...unknownParamNames.entries()].sort((a,b) => b[1]-a[1]).forEach(([n,c]) => console.log(`  ${n.padEnd(20)} x${c}`));
  }
  console.log("\nExamples of nested-macro misalignment (A):");
  cats.A_nested_misalignment.slice(0, 5).forEach(e => console.log(`  ${e.dcId} "${e.title}" cloud=${e.cloudMacros} dcRaw=${e.dcRaw} dcExtracted=${e.dcExtracted}`));
  console.log("\nExamples of extractor-bug (D):");
  cats.D_extractor_bug.slice(0, 5).forEach(e => console.log(`  ${e.dcId} "${e.title}" params=[${e.paramNames.join(",")}]`));
  console.log("\nExamples of legit-empty (C):");
  cats.C_legit_empty.slice(0, 5).forEach(e => console.log(`  ${e.dcId} "${e.title}" dcMacros=${e.dcRaw}`));

  fs.writeFileSync("/tmp/diag_empty_groups_result.json", JSON.stringify({ sampleSize: total, cats, unknownParamNames: Object.fromEntries(unknownParamNames) }, null, 2));
  console.log("\nFull details saved to /tmp/diag_empty_groups_result.json");
})().catch(e => { console.error("FATAL", e.message, e.stack); process.exit(1); });
