require("dotenv").config({ path: ".env" });
const fs = require("fs");
const Cloud = require("./src/cloudConfluenceClient");
const VMP = require("./src/visibilityMacroProcessor");

const SAMPLE_SIZE = parseInt(process.argv[2] || "30", 10);
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

const cloud = new Cloud(process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);
const proc = new VMP(null, cloud, null, null, { macroNames: ["show-if", "hide-if"] });

(async () => {
  const plan = JSON.parse(fs.readFileSync("logs/plan_1776716711969.json", "utf8"));

  // Build pool of pages where AT LEAST ONE macro had non-empty planned groupIds
  // and the page status is "completed".
  const pool = [];
  for (const [pid, p] of Object.entries(plan.pages)) {
    if (p.status !== "completed" || !p.macros) continue;
    if (p.macros.some(m => m.groupIds && m.groupIds.length > 0)) pool.push(p);
  }
  console.log(`Pool of completed pages with planned groupIds: ${pool.length}`);

  const sample = [];
  const taken = new Set();
  while (sample.length < Math.min(SAMPLE_SIZE, pool.length)) {
    const idx = Math.floor(rng() * pool.length);
    if (taken.has(idx)) continue;
    taken.add(idx);
    sample.push(pool[idx]);
  }
  console.log(`Sampling ${sample.length} pages\n`);

  let macrosWithPlannedGroups = 0;
  let macrosLanded = 0;
  let macrosMissingInLive = 0;
  let macrosLiveStillLegacy = 0;
  let macrosLiveForgeButNoGroups = 0;
  let macrosLiveForgeWithGroups = 0;
  const failingExamples = [];

  let i = 0;
  for (const p of sample) {
    i++;
    process.stdout.write(`[${i}/${sample.length}] Cloud=${p.cloudPageId} "${p.title.substring(0,40)}" `);
    let live;
    try { live = await cloud.getPageAdf(p.cloudPageId); }
    catch (e) { console.log(`FETCH ERR ${e.statusCode}`); continue; }
    const adfRaw = live.body?.atlas_doc_format?.value;
    if (!adfRaw) { console.log("(no adf)"); continue; }
    let adf;
    try { adf = JSON.parse(adfRaw); } catch { console.log("(adf parse fail)"); continue; }
    const liveNodes = proc.collectVisibilityNodes(adf);
    const liveById = new Map();
    for (const n of liveNodes) {
      const mid = n.node.attrs?.parameters?.macroMetadata?.macroId?.value;
      if (mid) liveById.set(mid, n);
    }

    let pageMisses = [];
    for (const planned of p.macros) {
      if (!planned.groupIds || planned.groupIds.length === 0) continue;
      macrosWithPlannedGroups++;
      const live = liveById.get(planned.macroId) || liveNodes[planned.index] || null;
      if (!live) { macrosMissingInLive++; pageMisses.push({ id: planned.macroId, reason: "not in live" }); continue; }
      const ek = live.node.attrs?.extensionKey || "";
      const et = live.node.attrs?.extensionType || "";
      const isForge = et === "com.atlassian.ecosystem";
      if (!isForge) { macrosLiveStillLegacy++; pageMisses.push({ id: planned.macroId, reason: `still legacy: ek=${ek} et=${et}` }); continue; }
      const liveGroupIds = live.node.attrs?.parameters?.guestParams?.groupIds || "";
      const liveMacroParamsGroup = live.node.attrs?.parameters?.macroParams?.group?.value || live.node.attrs?.parameters?.macroParams?.group || "";
      const plannedSet = new Set(planned.groupIds.split(","));
      const liveSet = new Set(liveGroupIds.split(",").filter(Boolean));
      const allLanded = [...plannedSet].every(id => liveSet.has(id));
      if (allLanded && liveGroupIds) {
        macrosLanded++;
        macrosLiveForgeWithGroups++;
      } else if (!liveGroupIds) {
        macrosLiveForgeNoGroupsCount(); function macrosLiveForgeNoGroupsCount() {} // noop
        macrosLiveForgeButNoGroups++;
        pageMisses.push({ id: planned.macroId, reason: `forge but groupIds="" (planned=${planned.groupIds.substring(0,40)}, macroParams.group="${liveMacroParamsGroup.substring(0,40)}")` });
      } else {
        pageMisses.push({ id: planned.macroId, reason: `partial. planned=${planned.groupIds.substring(0,60)} live=${liveGroupIds.substring(0,60)}` });
      }
    }
    if (pageMisses.length === 0) console.log("OK"); else {
      console.log(`MISSES=${pageMisses.length}`);
      if (failingExamples.length < 5) failingExamples.push({ cloud: p.cloudPageId, title: p.title, misses: pageMisses });
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("WRITE VERIFICATION");
  console.log("=".repeat(60));
  console.log(`Macros where plan had non-empty groupIds:   ${macrosWithPlannedGroups}`);
  console.log(`  Landed in Cloud (forge, groupIds match):  ${macrosLanded}  (${(macrosLanded/macrosWithPlannedGroups*100).toFixed(1)}%)`);
  console.log(`  Live macro NOT FOUND:                     ${macrosMissingInLive}`);
  console.log(`  Live macro is still LEGACY (not Forge):   ${macrosLiveStillLegacy}`);
  console.log(`  Live is Forge but groupIds is EMPTY:      ${macrosLiveForgeButNoGroups}`);
  console.log();
  for (const e of failingExamples) {
    console.log(`  Cloud=${e.cloud} "${e.title.substring(0,60)}"`);
    e.misses.slice(0, 4).forEach(m => console.log(`    macroId=${m.id}: ${m.reason}`));
  }
})().catch(e => { console.error("FATAL", e.message, e.stack); process.exit(1); });
