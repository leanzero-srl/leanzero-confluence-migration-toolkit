require("dotenv").config({ path: ".env" });
const fs = require("fs");
const Cloud = require("./src/cloudConfluenceClient");
const VMP = require("./src/visibilityMacroProcessor");

const SAMPLE = parseInt(process.argv[2] || "30", 10);
const SEED = parseInt(process.argv[3] || "42", 10);

function mulberry32(a) { return function () { let t = (a += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(SEED);

const cloud = new Cloud(process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);
const proc = new VMP(null, cloud, null, null, { macroNames: ["show-if", "hide-if"] });

(async () => {
  const plan = JSON.parse(fs.readFileSync("logs/plan_1776716711969.json", "utf8"));
  const pages = Object.values(plan.pages).filter(p => p.status === "completed" && p.macros && p.macros.length > 0);
  // Bias: prefer multi-macro pages where duplication would be most visible
  pages.sort((a, b) => b.macros.length - a.macros.length);
  const topMulti = pages.slice(0, Math.floor(pages.length * 0.3));
  const sample = [];
  const taken = new Set();
  while (sample.length < Math.min(SAMPLE, topMulti.length)) {
    const idx = Math.floor(rng() * topMulti.length);
    if (taken.has(idx)) continue;
    taken.add(idx);
    sample.push(topMulti[idx]);
  }

  console.log(`Sampling ${sample.length} multi-macro completed pages\n`);
  let pagesWithDupNodes = 0;
  let totalLive = 0, totalPlanned = 0;
  const examples = [];

  for (let i = 0; i < sample.length; i++) {
    const p = sample[i];
    process.stdout.write(`[${i+1}/${sample.length}] Cloud=${p.cloudPageId} planned=${p.macros.length} `);
    let live;
    try { live = await cloud.getPageAdf(p.cloudPageId); }
    catch (e) { console.log("FETCH ERR", e.statusCode); continue; }
    const adfRaw = live.body?.atlas_doc_format?.value;
    if (!adfRaw) { console.log("(no adf)"); continue; }
    const adf = JSON.parse(adfRaw);
    const liveNodes = proc.collectVisibilityNodes(adf);
    totalLive += liveNodes.length;
    totalPlanned += p.macros.length;

    // Group live nodes by macroId. >1 with same id = real duplication on the page.
    const byId = new Map();
    for (const n of liveNodes) {
      const mid = n.node.attrs?.parameters?.macroMetadata?.macroId?.value || "(no-id)";
      byId.set(mid, (byId.get(mid)||0) + 1);
    }
    const dupIds = [...byId.entries()].filter(([k,v]) => k !== "(no-id)" && v > 1);

    const note = [
      liveNodes.length !== p.macros.length ? `live≠planned(${liveNodes.length}vs${p.macros.length})` : null,
      dupIds.length ? `DUPS:${dupIds.map(([k,v])=>`${k.substring(0,8)}x${v}`).join(",")}` : null,
    ].filter(Boolean).join(" ");
    console.log(note || "OK");
    if (dupIds.length) {
      pagesWithDupNodes++;
      if (examples.length < 5) examples.push({ cloud: p.cloudPageId, title: p.title, planned: p.macros.length, live: liveNodes.length, dups: dupIds });
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("DUP CHECK SUMMARY");
  console.log("=".repeat(60));
  console.log(`Sampled pages:                          ${sample.length}`);
  console.log(`Pages with same-page macroId dupes:     ${pagesWithDupNodes}`);
  console.log(`Total live nodes seen:                  ${totalLive}`);
  console.log(`Total planned (in plan file):           ${totalPlanned}`);
  for (const e of examples) {
    console.log(`  ${e.cloud} "${e.title.substring(0,50)}" planned=${e.planned} live=${e.live} dups=${e.dups.map(([k,v]) => `${k.substring(0,8)}x${v}`).join(",")}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
