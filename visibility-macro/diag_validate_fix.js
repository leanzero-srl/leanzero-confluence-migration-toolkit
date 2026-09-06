require("dotenv").config({ path: ".env" });
const fs = require("fs");
const DC = require("./src/datacenterConfluenceClient");
const Cloud = require("./src/cloudConfluenceClient");
const VMP = require("./src/visibilityMacroProcessor");

const SAMPLE_SIZE = parseInt(process.argv[2] || "150", 10);
const SEED = parseInt(process.argv[3] || "42", 10);

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

(async () => {
  const plan = JSON.parse(fs.readFileSync("logs/plan_1776716711969.json", "utf8"));

  // Same pool / sampling as the categorization diagnostic
  const pool = [];
  for (const [pid, p] of Object.entries(plan.pages)) {
    if (!p.dcPageId || !p.macros || !p.macros.length) continue;
    const allEmpty = p.macros.every(m => !m.sourceGroupNames && !m.sourceUserNames);
    if (allEmpty) pool.push(p);
  }
  const sample = [];
  const taken = new Set();
  while (sample.length < Math.min(SAMPLE_SIZE, pool.length)) {
    const idx = Math.floor(rng() * pool.length);
    if (taken.has(idx)) continue;
    taken.add(idx);
    sample.push(pool[idx]);
  }
  console.log(`Validating fix on ${sample.length} pages from empty-source pool (size=${pool.length}, seed=${SEED})\n`);

  let pagesWithRecoveredGroups = 0;
  let pagesWithRecoveredUsers = 0;
  let macrosTotal = 0;
  let macrosRecoveredGroups = 0;
  let macrosRecoveredUsers = 0;
  let macrosStillEmpty = 0;
  let macrosNoMacroIdMatch = 0;
  let macrosMacroIdMatched = 0;

  const examples = [];

  let i = 0;
  for (const p of sample) {
    i++;
    let dcPage;
    try { dcPage = await dc.getPageContent(p.dcPageId); }
    catch { continue; }
    const body = dcPage.body?.storage?.value || "";
    const dcMacros = proc.extractDcParamsFromStorage(body);
    const dcById = new Map();
    for (const m of dcMacros) if (m.macroId) dcById.set(m.macroId, m);

    let pageRecoveredG = false, pageRecoveredU = false;
    const perMacro = [];

    for (let j = 0; j < p.macros.length; j++) {
      const planned = p.macros[j];
      macrosTotal++;
      const dc =
        (planned.macroId && !planned.macroId.startsWith("idx-") && dcById.get(planned.macroId))
        || dcMacros[j]
        || null;
      const matched = !!(planned.macroId && !planned.macroId.startsWith("idx-") && dcById.get(planned.macroId));
      if (matched) macrosMacroIdMatched++;
      else macrosNoMacroIdMatch++;

      const newG = (dc?.params?.group || dc?.params?.groups || dc?.params?.["user-groups"] || "").trim();
      const newU = (dc?.params?.users || dc?.params?.user || "").trim();
      if (newG) { macrosRecoveredGroups++; pageRecoveredG = true; }
      if (newU) { macrosRecoveredUsers++; pageRecoveredU = true; }
      if (!newG && !newU) macrosStillEmpty++;

      perMacro.push({ macroName: planned.macroName, matched, newG: newG.substring(0, 80), newU: newU.substring(0, 80) });
    }
    if (pageRecoveredG) pagesWithRecoveredGroups++;
    if (pageRecoveredU) pagesWithRecoveredUsers++;
    if ((pageRecoveredG || pageRecoveredU) && examples.length < 8) {
      examples.push({ dc: p.dcPageId, cloud: p.cloudPageId, title: p.title, perMacro });
    }
  }

  console.log("=".repeat(60));
  console.log("FIX VALIDATION on empty-source sample");
  console.log("=".repeat(60));
  console.log(`Sample pages:                      ${sample.length}`);
  console.log(`Pages where fix recovers groups:   ${pagesWithRecoveredGroups}  (${(pagesWithRecoveredGroups/sample.length*100).toFixed(1)}%)`);
  console.log(`Pages where fix recovers users:    ${pagesWithRecoveredUsers}  (${(pagesWithRecoveredUsers/sample.length*100).toFixed(1)}%)`);
  console.log();
  console.log(`Macros total:                      ${macrosTotal}`);
  console.log(`Macros matched by macroId:         ${macrosMacroIdMatched}  (${(macrosMacroIdMatched/macrosTotal*100).toFixed(1)}%)`);
  console.log(`Macros falling back to ordinal:    ${macrosNoMacroIdMatch}  (${(macrosNoMacroIdMatch/macrosTotal*100).toFixed(1)}%)`);
  console.log(`Macros where fix recovers groups:  ${macrosRecoveredGroups}  (${(macrosRecoveredGroups/macrosTotal*100).toFixed(1)}%)`);
  console.log(`Macros where fix recovers users:   ${macrosRecoveredUsers}  (${(macrosRecoveredUsers/macrosTotal*100).toFixed(1)}%)`);
  console.log(`Macros still empty after fix:      ${macrosStillEmpty}  (${(macrosStillEmpty/macrosTotal*100).toFixed(1)}%)`);
  console.log();
  console.log("Examples of recovered macros:");
  for (const e of examples) {
    console.log(`  DC=${e.dc} Cloud=${e.cloud} "${e.title.substring(0,60)}"`);
    e.perMacro.forEach((m, idx) => {
      const tag = (m.newG || m.newU) ? "RECOVERED" : "(empty)";
      console.log(`    [${idx}] ${m.macroName} matched=${m.matched ? "byId" : "ordinal"} ${tag} g="${m.newG}" u="${m.newU}"`);
    });
  }
})().catch(e => { console.error("FATAL", e.message, e.stack); process.exit(1); });
