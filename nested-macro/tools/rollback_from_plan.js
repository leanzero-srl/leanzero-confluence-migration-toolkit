#!/usr/bin/env node

/**
 * Roll back un-nest changes by restoring the pre-run storage from
 * Confluence Cloud's version history.
 *
 * Insurance script: if the big un-nest run goes wrong, run this to put
 * pages back to their pre-run state. For each page in the plan with
 * status="completed", we:
 *   1. Fetch the page's current state from Cloud.
 *   2. If current version > plan's recorded post-PUT version, the page
 *      was edited by someone else AFTER our un-nest. Skip with a warning
 *      — auto-rolling back would clobber their edit. The user can decide
 *      manually via Cloud's page history UI.
 *   3. Otherwise: fetch the historical version (recorded_version - 1)
 *      via the v1 API, then PUT that content back as a new version. This
 *      is non-destructive — Cloud's version history keeps everything.
 *
 * The plan entry status flips to "rolled-back" so re-runs are idempotent.
 *
 * Usage:
 *   node --max-old-space-size=4096 tools/rollback_from_plan.js \
 *     --plan-file logs/plan_1778319038952.json [options]
 *
 * Options:
 *   --space <KEY>       Restrict to space(s) — repeatable / comma-separated
 *   --page-id <id>      Restrict to specific page IDs — repeatable
 *   --limit <N>         Cap rollback count
 *   --dry-run           Show what would be rolled back, no writes
 *   --concurrency <N>   Parallel workers (default 3 — conservative)
 *   --help              This message
 *
 * Memory: pass `node --max-old-space-size=4096` for tenant-wide plans.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");

function showHelp() {
  console.log(`
Roll back un-nest changes by restoring pre-run storage from Cloud version history.

Usage:
  node --max-old-space-size=4096 tools/rollback_from_plan.js [options]

Required:
  --plan-file <path>     Plan JSON to roll back

Optional:
  --space <KEY>          Restrict to space(s) (repeatable / comma-separated)
  --page-id <id>         Restrict to specific page IDs (repeatable)
  --limit <N>            Cap pages rolled back
  --dry-run              Show what would be done, no writes
  --concurrency <N>      Parallel workers (default 3)
  --help                 Show this message

How it works:
  For each page in the plan with status="completed", fetch the historical
  version from Cloud's version history (the version BEFORE our un-nest PUT)
  and restore it. The intermediate (un-nested) version stays in Cloud's
  history — rollback is non-destructive.

  Pages with subsequent third-party edits are SKIPPED with a warning.
  Pages still pending/failed/skipped are left alone (we never modified them).

Examples:
  # Roll back everything
  node --max-old-space-size=4096 tools/rollback_from_plan.js \\
    --plan-file logs/plan_1778319038952.json

  # Dry-run first to see what would happen
  node --max-old-space-size=4096 tools/rollback_from_plan.js \\
    --plan-file logs/plan_1778319038952.json --dry-run

  # Roll back just the PER space
  node --max-old-space-size=4096 tools/rollback_from_plan.js \\
    --plan-file logs/plan_1778319038952.json --space P6
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { spaceKeys: [], pageIds: [], limit: 0, dryRun: false, concurrency: 3 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
        showHelp();
        process.exit(0);
      case "--plan-file":
        out.planFile = args[++i];
        break;
      case "--space": {
        const v = args[++i];
        if (v) out.spaceKeys.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--page-id":
        if (args[++i]) out.pageIds.push(args[i]);
        break;
      case "--limit":
        out.limit = parseInt(args[++i], 10) || 0;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--concurrency":
        out.concurrency = parseInt(args[++i], 10) || 3;
        break;
      default:
        if (a.startsWith("--")) console.warn(`Unknown option: ${a}`);
        break;
    }
  }
  return out;
}

/**
 * Fetch a historical version of a page via the v1 API.
 * Returns `{ title, version: {number}, body: { storage: { value } } }` or null if not found.
 *
 * v2 doesn't expose arbitrary historical versions in a single body fetch,
 * so we use v1 with status=historical&version=N. Pattern is well-supported.
 */
async function fetchHistoricalVersion(client, pageId, versionNumber) {
  const path = `/rest/api/content/${pageId}?status=historical&version=${versionNumber}&expand=body.storage,version,space`;
  return await client.makeRequest("GET", path);
}

async function rollbackOne(client, pageId, planEntry, opts, planManager) {
  // The plan recorded `version` as the post-PUT value (current_version + 1
  // at PUT time). The pre-run version is therefore `version - 1`.
  const recordedVersion = planEntry.version;
  if (typeof recordedVersion !== "number" || recordedVersion < 2) {
    return { pageId, status: "skipped", reason: "no recorded post-PUT version" };
  }
  const targetVersion = recordedVersion - 1;

  // 1. Fetch CURRENT state
  let current;
  try {
    current = await client.getPageWithStorage(pageId);
  } catch (err) {
    return { pageId, status: "failed", reason: `fetch current: ${err.message}` };
  }
  const currentVersion = current?.version?.number;
  const currentTitle = current?.title;
  if (typeof currentVersion !== "number") {
    return { pageId, status: "failed", reason: "no current version" };
  }

  // 2. Detect intervening edits
  if (currentVersion > recordedVersion) {
    return {
      pageId,
      status: "skipped-intervening",
      reason: `Cloud version is ${currentVersion}; plan recorded ${recordedVersion}. Someone edited AFTER our un-nest. Manual rollback via Cloud history UI required.`,
      currentTitle,
    };
  }
  if (currentVersion < recordedVersion) {
    return {
      pageId,
      status: "skipped-rolled-back",
      reason: `Cloud version is ${currentVersion} ≤ recorded ${recordedVersion}; already rolled back or never matched plan.`,
      currentTitle,
    };
  }

  // 3. Fetch the pre-run historical version
  let historical;
  try {
    historical = await fetchHistoricalVersion(client, pageId, targetVersion);
  } catch (err) {
    return { pageId, status: "failed", reason: `fetch historical v${targetVersion}: ${err.message}` };
  }
  const historicalStorage = historical?.body?.storage?.value;
  if (typeof historicalStorage !== "string") {
    return { pageId, status: "failed", reason: `historical v${targetVersion} has no storage body` };
  }

  if (opts.dryRun) {
    return {
      pageId,
      status: "would-rollback",
      currentTitle,
      currentVersion,
      targetVersion,
      bytes: historicalStorage.length,
    };
  }

  // 4. PUT historical content back as a new version (currentVersion + 1)
  const result = await client.updatePageStorage(
    pageId,
    currentTitle,
    historicalStorage,
    currentVersion,
    "Rollback to pre un-nest content (v" + targetVersion + ") - automated",
  );
  if (!result.success) {
    // 409 here means yet another edit landed between our GET and PUT;
    // surface to the user but don't auto-retry — rollback is sensitive.
    return { pageId, status: "failed", reason: `PUT: ${result.error || result.statusCode}` };
  }

  planManager.updatePageStatus(pageId, "rolled-back", {
    error: null,
    version: currentVersion + 1,
  });

  return {
    pageId,
    status: "rolled-back",
    currentTitle,
    fromVersion: currentVersion,
    restoredFromVersion: targetVersion,
    newVersion: currentVersion + 1,
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.planFile) {
    console.error("ERROR: --plan-file is required\n");
    showHelp();
    process.exit(1);
  }

  for (const k of ["CLOUD_BASE_URL", "CLOUD_EMAIL", "CLOUD_API_TOKEN"]) {
    if (!process.env[k]) {
      console.error(`ERROR: ${k} not set in .env`);
      process.exit(1);
    }
  }

  const planPath = path.resolve(opts.planFile);
  if (!fs.existsSync(planPath)) {
    console.error(`ERROR: plan file not found: ${planPath}`);
    process.exit(1);
  }

  const client = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  console.log(`Reading plan: ${planPath}`);
  const t0 = Date.now();
  const planManager = new PlanManager(path.dirname(planPath), console.log);
  planManager.setPlanFile(planPath);
  const plan = planManager.loadPlan(planPath);
  if (!plan) {
    console.error("ERROR: failed to load plan");
    process.exit(1);
  }
  console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Build candidate list: completed pages, optionally filtered.
  const spaceFilter = opts.spaceKeys.length > 0 ? new Set(opts.spaceKeys) : null;
  const idFilter = opts.pageIds.length > 0 ? new Set(opts.pageIds) : null;

  const candidates = [];
  for (const [pageId, page] of Object.entries(plan.pages)) {
    if (page.status !== "completed") continue;
    if (spaceFilter && !spaceFilter.has(page.spaceKey)) continue;
    if (idFilter && !idFilter.has(pageId)) continue;
    if (page.beforeHash && page.afterHash && page.beforeHash === page.afterHash) {
      // No-op completion (semanticHash matched) — nothing to roll back
      continue;
    }
    candidates.push([pageId, page]);
  }

  console.log(`Rollback candidates: ${candidates.length.toLocaleString()} pages`);
  if (opts.limit > 0 && candidates.length > opts.limit) {
    console.log(`  Capped to first ${opts.limit} per --limit`);
    candidates.length = opts.limit;
  }
  if (opts.dryRun) console.log("  *** DRY RUN — no writes ***");
  console.log("");

  if (candidates.length === 0) {
    console.log("Nothing to roll back. Exit.");
    return;
  }

  // Connection test
  if (!(await client.testConnection())) {
    console.error("ERROR: Cloud connection test failed");
    process.exit(1);
  }
  console.log("Cloud connection OK\n");

  const total = candidates.length;
  let cursor = 0;
  const stats = {
    rolledBack: 0,
    wouldRollback: 0,
    skippedIntervening: 0,
    skippedRolledBack: 0,
    skippedOther: 0,
    failed: 0,
  };
  const interventionList = [];
  const failures = [];

  const next = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const [pageId, planEntry] = candidates[idx];
      const result = await rollbackOne(client, pageId, planEntry, opts, planManager, idx + 1, total);

      switch (result.status) {
        case "rolled-back":
          stats.rolledBack++;
          console.log(`  [${idx + 1}/${total}] ROLLED BACK ${pageId} "${result.currentTitle}" v${result.fromVersion}→v${result.newVersion} (restored from v${result.restoredFromVersion})`);
          break;
        case "would-rollback":
          stats.wouldRollback++;
          console.log(`  [${idx + 1}/${total}] DRY ${pageId} "${result.currentTitle}" v${result.currentVersion}→v${result.currentVersion + 1} (would restore from v${result.targetVersion}, ${result.bytes} bytes)`);
          break;
        case "skipped-intervening":
          stats.skippedIntervening++;
          interventionList.push({ pageId, ...result });
          console.log(`  [${idx + 1}/${total}] SKIP-INTERVENING ${pageId} "${result.currentTitle}": ${result.reason}`);
          break;
        case "skipped-rolled-back":
          stats.skippedRolledBack++;
          break;
        case "skipped":
          stats.skippedOther++;
          break;
        case "failed":
          stats.failed++;
          failures.push({ pageId, ...result });
          console.log(`  [${idx + 1}/${total}] FAIL ${pageId}: ${result.reason}`);
          break;
      }

      if (idx % 50 === 49 && !opts.dryRun) planManager.savePlan();
    }
  };

  const workers = [];
  for (let w = 0; w < opts.concurrency; w++) workers.push(next());
  await Promise.all(workers);

  if (!opts.dryRun) planManager.savePlan();

  // ─── Final report ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("ROLLBACK SUMMARY");
  console.log("=".repeat(70));
  if (opts.dryRun) console.log("*** DRY RUN — no changes were made ***\n");
  console.log(`  Candidates:                        ${total.toLocaleString()}`);
  if (opts.dryRun) {
    console.log(`  Would roll back:                   ${stats.wouldRollback.toLocaleString()}`);
  } else {
    console.log(`  Rolled back:                       ${stats.rolledBack.toLocaleString()}`);
  }
  console.log(`  Skipped (intervening edits):       ${stats.skippedIntervening.toLocaleString()}`);
  console.log(`  Skipped (already rolled back):     ${stats.skippedRolledBack.toLocaleString()}`);
  console.log(`  Skipped (other):                   ${stats.skippedOther.toLocaleString()}`);
  console.log(`  Failed:                            ${stats.failed.toLocaleString()}`);

  if (interventionList.length > 0) {
    console.log("\n  Pages with intervening edits — handle manually via Cloud history:");
    for (const e of interventionList.slice(0, 25)) {
      console.log(`    ${e.pageId} "${e.currentTitle}"`);
    }
    if (interventionList.length > 25) {
      console.log(`    ... and ${interventionList.length - 25} more (full list in plan)`);
    }
  }

  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const e of failures.slice(0, 25)) {
      console.log(`    ${e.pageId}: ${e.reason}`);
    }
    if (failures.length > 25) {
      console.log(`    ... and ${failures.length - 25} more`);
    }
  }

  console.log("\n  Tip: re-running this command is safe — already-rolled-back pages will be skipped.");
  console.log("=".repeat(70));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = { fetchHistoricalVersion, rollbackOne };
