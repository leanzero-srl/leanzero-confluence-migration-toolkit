#!/usr/bin/env node

/**
 * Rewrite an existing plan file in place to mark additional macro pairs as
 * `skip` strategy without re-scanning Cloud.
 *
 * Use case: after building a plan with the default --excluded-containers list,
 * you realise additional macro families (Scaffolding, Reporting Bundle, etc.)
 * have structural parent-child requirements that splitting would break.
 * Re-scanning a tenant-wide plan can take hours; this script is the cheap
 * alternative — it walks the existing plan and, for any nesting whose
 * `outerMacro` OR `innerMacro` is in the additional-excluded list, flips
 * `strategy` from "split" to "skip".
 *
 * Pages whose nestings ALL become "skip" effectively become no-ops — the
 * execute phase will hit the no-op-hash check and not PUT them.
 *
 * Usage:
 *   node tools/rewrite_plan_excluded.js \
 *     --plan-file logs/plan_<timestamp>.json \
 *     --add-excluded report-block,report-body,local-reporter,...
 *
 * The original plan is preserved as <plan>.bak before the rewrite.
 *
 * Memory: a tenant-wide plan can be 300-500MB JSON. Run this with at least
 *   node --max-old-space-size=4096 tools/rewrite_plan_excluded.js ...
 */

const fs = require("fs");
const path = require("path");

function showHelp() {
  console.log(`
Rewrite plan excluded-containers in place

Usage:
  node tools/rewrite_plan_excluded.js [options]

Required:
  --plan-file <path>       Plan JSON to rewrite (in place)
  --add-excluded <list>    Comma-separated macro names to add to the
                           excluded set (matches outerMacro OR innerMacro)

Options:
  --dry-run                Print what would change, don't write
  --help                   Show this message

Examples:
  # Mark Reporting Bundle macros as skip
  node tools/rewrite_plan_excluded.js \\
    --plan-file logs/plan_1778319038952.json \\
    --add-excluded report-block,report-body,report-info,report-empty,report-on,report-table,local-reporter,text-filter,date-filter,select-filter,user-filter

  # Dry-run first to see how many strategies would flip
  node tools/rewrite_plan_excluded.js \\
    --plan-file logs/plan_1778319038952.json \\
    --add-excluded list-data,list-option,text-data,date-data \\
    --dry-run
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { addExcluded: [], dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
        showHelp();
        process.exit(0);
      case "--plan-file":
        out.planFile = args[++i];
        break;
      case "--add-excluded": {
        const v = args[++i];
        if (v) out.addExcluded.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--dry-run":
        out.dryRun = true;
        break;
      default:
        if (a.startsWith("--")) console.warn(`Unknown option: ${a}`);
        break;
    }
  }
  return out;
}

/**
 * Stream-write the rewritten plan in the same compact format the live
 * PlanManager uses (one page per line) — keeps the file shape identical
 * so the existing loader is unaffected.
 */
function streamWritePlan(filePath, plan) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "w");
    fs.writeSync(fd, "{\n");
    fs.writeSync(fd, `"version":${JSON.stringify(plan.version)},\n`);
    fs.writeSync(fd, `"runId":${JSON.stringify(plan.runId)},\n`);
    fs.writeSync(fd, `"createdAt":${JSON.stringify(plan.createdAt)},\n`);
    fs.writeSync(fd, `"updatedAt":${JSON.stringify(plan.updatedAt)},\n`);
    fs.writeSync(fd, `"stats":${JSON.stringify(plan.stats)},\n`);
    fs.writeSync(fd, `"totals":${JSON.stringify(plan.totals)},\n`);
    fs.writeSync(fd, `"pages":{\n`);

    const pageIds = Object.keys(plan.pages);
    for (let i = 0; i < pageIds.length; i++) {
      const key = pageIds[i];
      const comma = i < pageIds.length - 1 ? ",\n" : "\n";
      fs.writeSync(fd, `${JSON.stringify(key)}:${JSON.stringify(plan.pages[key])}${comma}`);
    }

    fs.writeSync(fd, "}\n}");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function main() {
  const opts = parseArgs();

  if (!opts.planFile) {
    console.error("ERROR: --plan-file is required\n");
    showHelp();
    process.exit(1);
  }
  if (opts.addExcluded.length === 0) {
    console.error("ERROR: --add-excluded must list one or more macro names\n");
    showHelp();
    process.exit(1);
  }

  const planPath = path.resolve(opts.planFile);
  if (!fs.existsSync(planPath)) {
    console.error(`ERROR: plan file not found: ${planPath}`);
    process.exit(1);
  }

  console.log(`Reading plan: ${planPath}`);
  const t0 = Date.now();
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const excluded = new Set(opts.addExcluded);
  console.log(`Adding ${excluded.size} macro names to excluded set:`);
  console.log(`  ${[...excluded].join(", ")}\n`);

  let pagesScanned = 0;
  let pagesTouched = 0;
  let nestingsFlipped = 0;
  let pagesAllSkipped = 0;
  let pagesNowAllSkippedNew = 0;

  // Per-pair counts so we can see what we actually flipped
  const flipsByPair = new Map();

  for (const [, page] of Object.entries(plan.pages || {})) {
    pagesScanned++;
    if (!Array.isArray(page.nestings) || page.nestings.length === 0) continue;

    let touched = false;
    const wasAllSkip = page.nestings.every((n) => n.strategy !== "split");

    for (const n of page.nestings) {
      if (n.strategy !== "split") continue;
      if (excluded.has(n.outerMacro) || excluded.has(n.innerMacro)) {
        n.strategy = "skip";
        nestingsFlipped++;
        touched = true;
        const key = `${n.outerMacro} > ${n.innerMacro}`;
        flipsByPair.set(key, (flipsByPair.get(key) || 0) + 1);
      }
    }

    if (touched) pagesTouched++;
    if (page.nestings.every((n) => n.strategy !== "split")) {
      pagesAllSkipped++;
      if (!wasAllSkip) pagesNowAllSkippedNew++;
    }
  }

  console.log("=".repeat(60));
  console.log("REWRITE SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Pages scanned:                        ${pagesScanned.toLocaleString()}`);
  console.log(`  Pages touched (≥1 strategy flipped):  ${pagesTouched.toLocaleString()}`);
  console.log(`  Nesting strategies flipped to skip:   ${nestingsFlipped.toLocaleString()}`);
  console.log(`  Pages now 100% no-op (skip-only):     ${pagesAllSkipped.toLocaleString()}`);
  console.log(`  Pages newly demoted to no-op:         ${pagesNowAllSkippedNew.toLocaleString()}`);
  console.log("");

  if (flipsByPair.size > 0) {
    console.log("Top flipped pairs (outer > inner → count):");
    const sorted = [...flipsByPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    for (const [pair, count] of sorted) {
      console.log(`  ${pair.padEnd(50)} ${count.toLocaleString()}`);
    }
    console.log("");
  }

  if (opts.dryRun) {
    console.log("--dry-run: not writing. Re-run without --dry-run to apply.");
    return;
  }

  // updatedAt — record when this rewrite happened
  plan.updatedAt = new Date().toISOString();

  const backupPath = planPath + ".bak";
  console.log(`Backing up original to: ${backupPath}`);
  fs.copyFileSync(planPath, backupPath);

  console.log(`Writing rewritten plan: ${planPath}`);
  const tw = Date.now();
  streamWritePlan(planPath, plan);
  console.log(`  written in ${((Date.now() - tw) / 1000).toFixed(1)}s`);

  console.log("\nDone. The execute phase will now treat the flipped nestings");
  console.log("as 'skip' (no split), and pages whose entire nesting set is now");
  console.log("'skip' will be no-op skipped at PUT time.");
}

if (require.main === module) main();

module.exports = { streamWritePlan };
