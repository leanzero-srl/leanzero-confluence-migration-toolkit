#!/usr/bin/env node
// Analyse a fresh visibility-macro plan and compare it to the May 9 plan.
// Usage: node analyse_replan.js logs/plan_<newId>.json [logs/plan_1778311380618.json]

const fs = require("fs");
const path = require("path");

const newPath = process.argv[2];
const oldPath = process.argv[3] || "logs/plan_1778311380618.json";
if (!newPath) { console.error("usage: node analyse_replan.js <new-plan> [old-plan]"); process.exit(1); }

const newP = JSON.parse(fs.readFileSync(newPath, "utf8"));
const oldP = JSON.parse(fs.readFileSync(oldPath, "utf8"));

function summary(plan) {
  const pgs = Object.values(plan.pages || {});
  let totalMacros = 0, withGroups = 0, empty = 0, unresolved = 0;
  let legacy = 0, forge = 0;
  let realId = 0, synthId = 0;
  let pagesAllEmpty = 0, pagesAnyGroups = 0;
  for (const p of pgs) {
    let pageHasGroups = false;
    for (const m of (p.macros || [])) {
      totalMacros++;
      const has = !!(m.sourceGroupNames || m.sourceUserNames);
      if (has) { withGroups++; pageHasGroups = true; } else empty++;
      if ((m.unresolvedGroups||[]).length || (m.unresolvedUsers||[]).length) unresolved++;
      if (m.flavor === "forge") forge++;
      else if (m.flavor === "legacy") legacy++;
      if (String(m.macroId||"").startsWith("idx-")) synthId++;
      else realId++;
    }
    if (pageHasGroups) pagesAnyGroups++;
    else if ((p.macros||[]).length > 0) pagesAllEmpty++;
  }
  return {
    runId: plan.runId, createdAt: plan.createdAt,
    pages: pgs.length, totalMacros, withGroups, empty, unresolved,
    legacy, forge, realId, synthId,
    pagesAnyGroups, pagesAllEmpty,
    statsBlock: plan.stats,
  };
}

const newS = summary(newP);
const oldS = summary(oldP);

console.log("=".repeat(70));
console.log("OLD PLAN", oldPath);
console.log("=".repeat(70));
console.log(JSON.stringify(oldS, null, 2));
console.log();
console.log("=".repeat(70));
console.log("NEW PLAN", newPath);
console.log("=".repeat(70));
console.log(JSON.stringify(newS, null, 2));

// Side-by-side comparison
console.log();
console.log("=".repeat(70));
console.log("DIFF (NEW - OLD)");
console.log("=".repeat(70));
const fields = ["pages","totalMacros","withGroups","empty","unresolved","legacy","forge","realId","synthId","pagesAnyGroups","pagesAllEmpty"];
for (const f of fields) {
  const d = newS[f] - oldS[f];
  const sign = d > 0 ? "+" : "";
  console.log(`  ${f.padEnd(20)} old=${String(oldS[f]).padStart(7)}  new=${String(newS[f]).padStart(7)}  diff=${sign}${d}`);
}

// Per-page diff: pages in BOTH plans, classify per-macro change
console.log();
console.log("=".repeat(70));
console.log("PER-PAGE OVERLAP / FLIP");
console.log("=".repeat(70));
const oldPgs = oldP.pages || {};
const newPgs = newP.pages || {};
let inBoth=0, onlyOld=0, onlyNew=0;
const flips = { emptyToFilled: 0, filledToEmpty: 0, sameEmpty: 0, sameFilled: 0 };
const flipExamples = [];
const filledToEmptyExamples = [];
for (const id of new Set([...Object.keys(oldPgs), ...Object.keys(newPgs)])) {
  const o = oldPgs[id], n = newPgs[id];
  if (o && !n) { onlyOld++; continue; }
  if (!o && n) { onlyNew++; continue; }
  inBoth++;
  // Pair macros — by macroId where both real, else ordinal
  const oM = o.macros || [], nM = n.macros || [];
  const len = Math.max(oM.length, nM.length);
  for (let i = 0; i < len; i++) {
    const om = oM[i], nm = nM[i];
    if (!om || !nm) continue;
    const oH = !!(om.sourceGroupNames || om.sourceUserNames);
    const nH = !!(nm.sourceGroupNames || nm.sourceUserNames);
    if (!oH && nH) { flips.emptyToFilled++; if (flipExamples.length<5) flipExamples.push({id, title:n.title, idx:i, oldGroups:om.sourceGroupNames||"", newGroups:nm.sourceGroupNames}); }
    else if (oH && !nH) { flips.filledToEmpty++; if (filledToEmptyExamples.length<5) filledToEmptyExamples.push({id, title:n.title, idx:i, oldGroups:om.sourceGroupNames, newGroups:nm.sourceGroupNames||""}); }
    else if (oH && nH) flips.sameFilled++;
    else flips.sameEmpty++;
  }
}
console.log(`pages in both:  ${inBoth}`);
console.log(`pages only old: ${onlyOld}  (likely scaffolding-only pages now SKIPPED entirely)`);
console.log(`pages only new: ${onlyNew}`);
console.log(`macro flips:    ${JSON.stringify(flips)}`);
if (flipExamples.length) {
  console.log("\nempty→filled examples (showing groups recovered by re-plan):");
  flipExamples.forEach(e => console.log(`  page=${e.id} idx=${e.idx} "${e.title.slice(0,50)}"  newGroups="${e.newGroups}"`));
}
if (filledToEmptyExamples.length) {
  console.log("\nfilled→empty REGRESSIONS (groups LOST in re-plan — investigate before execute):");
  filledToEmptyExamples.forEach(e => console.log(`  page=${e.id} idx=${e.idx} "${e.title.slice(0,50)}"  oldGroups="${e.oldGroups}"`));
}

// pagesNoLongerInPlan: were in old plan, not in new plan. Likely all-scaffolding pages now skipped.
console.log();
console.log("=".repeat(70));
console.log("PAGES DROPPED FROM PLAN (were in old, not in new) — sample 10");
console.log("=".repeat(70));
let dropped = 0;
const droppedSample = [];
for (const id of Object.keys(oldPgs)) {
  if (!newPgs[id]) {
    dropped++;
    if (droppedSample.length<10) droppedSample.push({id, title: oldPgs[id].title, mCount: (oldPgs[id].macros||[]).length, mAllEmpty: (oldPgs[id].macros||[]).every(m=>!m.sourceGroupNames && !m.sourceUserNames)});
  }
}
console.log(`total dropped: ${dropped}`);
droppedSample.forEach(s => console.log(`  ${s.id} "${s.title.slice(0,60)}"  m=${s.mCount} allEmpty=${s.mAllEmpty}`));
