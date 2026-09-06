#!/usr/bin/env node

/**
 * restore_composition_tabs.js
 *
 * Roll back a sync_composition_tabs.js run.
 *
 * Two strategies:
 *   1. Native version restore (DEFAULT):
 *      POST /wiki/rest/api/content/{id}/version
 *        { operationKey: "RESTORE", params: { versionNumber: prev, message: "..." } }
 *      Atomic, audited, the official mechanism. Works as long as the
 *      historical version still exists in the page's history.
 *
 *   2. Local backup PUT (--from-backup):
 *      Reads the saved storage XHTML from backups/page_<id>_v<v>.xhtml,
 *      fetches the page's CURRENT version, and PUTs the saved XHTML at
 *      currentVersion + 1. Use this only if the native version history
 *      has been compacted/pruned, or you specifically want to overwrite
 *      back to the pre-migration content even though the page has been
 *      independently edited since.
 *
 * USAGE
 *   node main/restore_composition_tabs.js --plan-file logs/plan_<id>.json
 *   node main/restore_composition_tabs.js --plan-file logs/plan_<id>.json --dry-run
 *   node main/restore_composition_tabs.js --plan-file logs/plan_<id>.json --from-backup
 */

"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

function parseArgs(argv) {
  const o = {
    planFile: null,
    dryRun: false,
    fromBackup: false,
    concurrency: 3,
    message: "Revert Composition Tabs migration",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan-file": o.planFile = argv[++i]; break;
      case "--dry-run": o.dryRun = true; break;
      case "--from-backup": o.fromBackup = true; break;
      case "--concurrency": o.concurrency = parseInt(argv[++i], 10) || 3; break;
      case "--message": o.message = argv[++i]; break;
      case "--help":
      case "-h": o.help = true; break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          o.help = true;
        }
    }
  }
  return o;
}

function help() {
  console.log(`
Usage: node main/restore_composition_tabs.js --plan-file <path> [options]

  --plan-file PATH        plan JSON written by sync_composition_tabs.js
  --dry-run               simulate; don't call any write API
  --from-backup           PUT saved storage XHTML instead of using version-restore
  --concurrency N         worker pool size (default 3)
  --message MSG           audit message attached to the restore
`);
}

class CompositionTabsRestore {
  constructor(opts) {
    this.opts = opts;

    if (!process.env.CLOUD_BASE_URL || !process.env.CLOUD_EMAIL || !process.env.CLOUD_API_TOKEN) {
      throw new Error("Missing CLOUD_BASE_URL, CLOUD_EMAIL or CLOUD_API_TOKEN in .env");
    }

    this.scriptRoot = path.resolve(__dirname, "..");
    this.logDir = path.join(this.scriptRoot, "logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.logFile = path.join(this.logDir, `restore_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Composition Tabs Restore Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );

    this.stats = { restored: 0, skipped: 0, failed: 0 };
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try { fs.appendFileSync(this.logFile, line + "\n"); } catch (_) { /* ignore */ }
  }

  async runPool(items, fn, concurrency) {
    let idx = 0;
    const total = items.length;
    let done = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= total) return;
        try { await fn(items[i], i); }
        catch (e) { this.log(`  worker error: ${e.message}`); }
        done++;
        if (done % 10 === 0 || done === total) this.log(`  Progress: ${done}/${total}`);
      }
    });
    await Promise.all(workers);
  }

  loadPlan() {
    if (!this.opts.planFile) throw new Error("--plan-file <path> is required");
    const resolved = path.resolve(this.opts.planFile);
    if (!fs.existsSync(resolved)) throw new Error(`Plan file not found: ${resolved}`);
    const raw = fs.readFileSync(resolved, "utf8");
    return JSON.parse(raw);
  }

  async restoreOne(pageId, data) {
    const title = data.title || "<untitled>";

    if (data.status !== "completed" || !data.completedVersion) {
      this.stats.skipped++;
      this.log(`    "${title}" (${pageId}): skipped (status=${data.status}, no completedVersion)`);
      return;
    }

    if (this.opts.fromBackup) {
      const backupRel = data.backupPath;
      if (!backupRel) {
        this.stats.skipped++;
        this.log(`    "${title}" (${pageId}): skipped (no backup recorded in plan)`);
        return;
      }
      const backupAbs = path.resolve(this.scriptRoot, backupRel);
      if (!fs.existsSync(backupAbs)) {
        this.stats.failed++;
        this.log(`    "${title}" (${pageId}): backup file missing: ${backupAbs}`);
        return;
      }
      const savedXml = fs.readFileSync(backupAbs, "utf8");
      if (this.opts.dryRun) {
        this.stats.restored++;
        this.log(`    [DRY RUN] "${title}" (${pageId}): would PUT saved storage from ${backupRel}`);
        return;
      }
      // Fetch current version, PUT saved XHTML at current+1
      const sp = await this.cloudClient.getPageStorage(pageId);
      const r = await this.cloudClient.updatePageStorage(
        pageId,
        sp.title,
        sp.type || data.contentType || "page",
        savedXml,
        sp.version.number,
        this.opts.message,
      );
      if (r.success) {
        this.stats.restored++;
        this.log(`    "${title}" (${pageId}): restored from backup`);
      } else {
        this.stats.failed++;
        this.log(`    "${title}" (${pageId}): backup-PUT FAILED - ${r.error}`);
      }
      return;
    }

    // Default: native version restore
    const prevVersion = data.completedVersion - 1;
    if (prevVersion < 1) {
      this.stats.skipped++;
      this.log(`    "${title}" (${pageId}): skipped (no prior version: completedVersion=${data.completedVersion})`);
      return;
    }
    if (this.opts.dryRun) {
      this.stats.restored++;
      this.log(`    [DRY RUN] "${title}" (${pageId}): would restore version ${prevVersion}`);
      return;
    }
    const r = await this.cloudClient.restoreVersion(pageId, prevVersion, this.opts.message);
    if (r.success) {
      this.stats.restored++;
      this.log(`    "${title}" (${pageId}): restored to version ${prevVersion}`);
    } else {
      this.stats.failed++;
      this.log(`    "${title}" (${pageId}): RESTORE FAILED - ${r.error}`);
    }
  }

  async run() {
    this.log("Step 1: Testing Cloud connection...");
    if (!await this.cloudClient.testConnection()) throw new Error("Cloud connection failed");
    this.log("  Cloud: OK");

    this.log("\nStep 2: Loading plan...");
    const plan = this.loadPlan();
    const pages = Object.entries(plan.pages || {}).filter(([, d]) => d.status === "completed");
    this.log(`  Pages with status=completed: ${pages.length}`);

    this.log(`\nStep 3: ${this.opts.fromBackup ? "Restoring from local backups" : "Restoring via native version restore"} ${this.opts.dryRun ? "[DRY RUN]" : ""}...`);
    await this.runPool(pages, async ([pageId, data]) => {
      try {
        await this.restoreOne(pageId, data);
      } catch (e) {
        this.stats.failed++;
        this.log(`    "${data.title}" (${pageId}): ERROR - ${e.message}`);
      }
    }, this.opts.concurrency);

    this.log(`\nFinal:`);
    this.log(`  Restored: ${this.stats.restored}`);
    this.log(`  Skipped:  ${this.stats.skipped}`);
    this.log(`  Failed:   ${this.stats.failed}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }
  if (!opts.planFile) { help(); process.exit(1); }
  try {
    const r = new CompositionTabsRestore(opts);
    await r.run();
    console.log("\nDone.");
    process.exit(0);
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { CompositionTabsRestore, parseArgs };
