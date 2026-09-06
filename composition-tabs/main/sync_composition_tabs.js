#!/usr/bin/env node

/**
 * sync_composition_tabs.js
 *
 * Phase-1 fix for mis-migrated Appfire Composition Tabs.
 *
 * After Atlassian DC -> Cloud migration, Composition's Deck of Cards / Card
 * macros sometimes land in Cloud as <ac:structured-macro ac:name="deck"> /
 * ac:name="card">. Those names collide with Confluence Cloud native macros
 * and break rendering. Appfire's Cloud-compatible legacy equivalents are
 * tab-group / tab.
 *
 * This script CQL-scans Cloud, finds candidate pages, structurally verifies
 * each macro is really Composition (not a coincidentally-named native macro),
 * splice-rewrites the storage XHTML in place (deck -> tab-group, card -> tab,
 * card label -> tab title), saves a per-page backup + diff, and PUTs the
 * page back via the v1 storage representation.
 *
 * Default-deny verification:
 *   - deck: always Composition (Cloud-native panels never use ac:name="deck")
 *   - card: only rewritten if it has a deck/tab-group/tab ancestor OR a
 *           "label" parameter (configurable). Standalone cards without any
 *           Composition signal are skipped with a recorded reason.
 *
 * Operates on STORAGE format (XHTML) — not ADF. The target structure is
 * itself storage-format, so a pure splice rewrite preserves macro IDs,
 * schema versions, rich-text-body content, and unsupported parameters
 * byte-for-byte.
 *
 * USAGE
 *
 *   node main/sync_composition_tabs.js --dry-run --space DOCS --limit 1
 *   node main/sync_composition_tabs.js --plan-only --space DOCS
 *   node main/sync_composition_tabs.js --execute-only --plan-file logs/plan_<id>.json
 *   node main/sync_composition_tabs.js --space DOCS,KB --concurrency 5
 *   node main/sync_composition_tabs.js --all
 *
 * See `--help` for the full flag list. Required env (.env at script root):
 *   CLOUD_BASE_URL=https://your-tenant.atlassian.net/wiki
 *   CLOUD_EMAIL=you@example.com
 *   CLOUD_API_TOKEN=...
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");
const CompositionMacroProcessor = require("../src/compositionMacroProcessor");

// ─────────────────────────────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    planOnly: false,
    executeOnly: false,
    planFile: null,
    dryRun: false,
    spaceKeys: [],
    scanAllSpaces: false,
    limit: 0,
    concurrency: 3,
    retryFailed: false,
    oldDeckKeys: [],
    oldCardKeys: [],
    renameDeckId: true,
    cardLabelParam: "label",
    cardTitleParam: "title",
    versionMessage: "Composition Tabs migration fix: Deck/Card -> Tab Group/Tab",
    verifyAfter: true,
    backupDir: null,
    noBackup: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan-only": o.planOnly = true; break;
      case "--execute-only":
      case "--resume": o.executeOnly = true; break;
      case "--plan-file": o.planFile = argv[++i]; break;
      case "--dry-run": o.dryRun = true; break;
      case "--space": {
        const v = argv[++i];
        if (v) o.spaceKeys.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--all": o.scanAllSpaces = true; break;
      case "--limit": o.limit = parseInt(argv[++i], 10) || 0; break;
      case "--concurrency": o.concurrency = parseInt(argv[++i], 10) || 3; break;
      case "--retry-failed": o.retryFailed = true; break;
      case "--old-deck-key": o.oldDeckKeys.push(argv[++i]); break;
      case "--old-card-key": o.oldCardKeys.push(argv[++i]); break;
      case "--no-rename-deck-id": o.renameDeckId = false; break;
      case "--card-label-param": o.cardLabelParam = argv[++i]; break;
      case "--card-title-param": o.cardTitleParam = argv[++i]; break;
      case "--version-message": o.versionMessage = argv[++i]; break;
      case "--no-verify-after": o.verifyAfter = false; break;
      case "--backup-dir": o.backupDir = argv[++i]; break;
      case "--no-backup": o.noBackup = true; break;
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
Usage: node main/sync_composition_tabs.js [options]

Phases:
  default                   plan + execute in one run
  --plan-only               build plan, skip execute
  --execute-only [--plan-file <path>]   load plan and execute
  --dry-run                 simulate execute (no PUTs); still writes backups

Scope:
  --space K[,K...]          limit to one or more space keys
  --all                     scan every space (one of --space or --all required)
  --limit N                 cap the number of planned pages
  --concurrency N           worker pool size (default 3)
  --retry-failed            re-attempt pages with status="failed"

Rewrite tuning:
  --old-deck-key K          repeatable; default ["deck"]
  --old-card-key K          repeatable; default ["card"]
  --no-rename-deck-id       skip the deck "id" -> "deckId" rename (default: rename)
  --card-label-param NAME   source param to rename to title (default "label")
  --card-title-param NAME   target param name on tab (default "title")
  --version-message MSG     PUT version comment

Output:
  --backup-dir PATH         override default ./backups/
  --no-backup               don't write per-page backups (NOT RECOMMENDED)
  --no-verify-after         skip the post-run residual-CQL check
`);
}

// ─────────────────────────────────────────────────────────────────────
//  ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────

class CompositionTabsSync {
  constructor(opts) {
    this.opts = opts;

    if (!process.env.CLOUD_BASE_URL || !process.env.CLOUD_EMAIL || !process.env.CLOUD_API_TOKEN) {
      throw new Error(
        "Missing CLOUD_BASE_URL, CLOUD_EMAIL or CLOUD_API_TOKEN in .env (resolved relative to confluence/composition-tabs/)",
      );
    }

    this.scriptRoot = path.resolve(__dirname, "..");
    this.logDir = path.join(this.scriptRoot, "logs");
    this.backupDir = path.resolve(opts.backupDir || path.join(this.scriptRoot, "backups"));
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    if (!opts.noBackup && !fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Composition Tabs Sync Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, (m) => this.log(m));

    this.processor = new CompositionMacroProcessor({
      oldDeckKeys: opts.oldDeckKeys.length ? opts.oldDeckKeys : ["deck"],
      oldCardKeys: opts.oldCardKeys.length ? opts.oldCardKeys : ["card"],
      renameDeckId: opts.renameDeckId,
      cardLabelParam: opts.cardLabelParam,
      cardTitleParam: opts.cardTitleParam,
      log: (m) => this.log(m),
    });

    this.stats = {
      cloudPagesFound: 0,
      pagesPlanned: 0,
      pagesUpdated: 0,
      pagesSkipped: 0,
      pagesFailed: 0,
      macrosToRewrite: 0,
      macrosRewritten: 0,
      macrosAmbiguousSkipped: 0,
    };
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try { fs.appendFileSync(this.logFile, line + "\n"); } catch (_) { /* swallow */ }
  }

  async testConnection() {
    this.log("Step 1: Testing Cloud connection...");
    const ok = await this.cloudClient.testConnection();
    if (!ok) throw new Error("Cloud connection failed");
    this.log("  Cloud: OK");
  }

  async runPool(items, workerFn, concurrency) {
    let idx = 0;
    const total = items.length;
    let done = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= total) return;
        try {
          await workerFn(items[i], i);
        } catch (e) {
          this.log(`  worker error: ${e.message}`);
        }
        done++;
        if (done % 10 === 0 || done === total) {
          this.log(`  Progress: ${done}/${total}`);
        }
      }
    });
    await Promise.all(workers);
  }

  // ─── PHASE 1: BUILD PLAN ───────────────────────────────────────────

  async buildPlan() {
    if (!this.opts.scanAllSpaces && this.opts.spaceKeys.length === 0) {
      throw new Error("Specify --space KEY[,KEY,...] or --all");
    }

    const oldDeckKeys = this.opts.oldDeckKeys.length ? this.opts.oldDeckKeys : ["deck"];
    const oldCardKeys = this.opts.oldCardKeys.length ? this.opts.oldCardKeys : ["card"];
    const macroQuoted = [...new Set([...oldDeckKeys, ...oldCardKeys])]
      .map((k) => `"${k}"`)
      .join(",");

    const spaces = this.opts.spaceKeys.length > 0
      ? this.opts.spaceKeys.map((k) => ({ key: k }))
      : [{ key: null }];

    const candidates = [];
    let stop = false;
    for (const sp of spaces) {
      this.log(`\nScanning space: ${sp.key || "<all>"}`);
      const cql = sp.key
        ? `space = "${sp.key}" AND macro in (${macroQuoted}) AND type = page ORDER BY id`
        : `macro in (${macroQuoted}) AND type = page ORDER BY id`;

      await this.cloudClient.searchContentByCql(cql, "version,space", async (results) => {
        for (const p of results) {
          this.stats.cloudPagesFound++;
          candidates.push(p);
          if (this.opts.limit > 0 && candidates.length >= this.opts.limit) {
            stop = true;
            break;
          }
        }
        if (stop) return false;
      });
      if (stop) break;
    }
    this.log(`\n  Candidate pages from CQL: ${candidates.length}`);

    const runId = String(Date.now());
    this.planManager.createPlan(runId);

    await this.runPool(candidates, async (cp) => {
      const id = String(cp.id);
      const title = cp.title;
      const spaceKey = cp.space?.key || null;

      let storagePage;
      try {
        storagePage = await this.cloudClient.getPageStorage(id);
      } catch (e) {
        this.log(`    "${title}" (${id}): storage fetch failed: ${e.message}`);
        return;
      }
      const storage = storagePage.body?.storage?.value || "";
      const currentVersion = storagePage.version?.number;
      if (!storage || !currentVersion) {
        this.log(`    "${title}" (${id}): empty storage or missing version, skipping`);
        return;
      }

      const instances = this.processor.findCandidateMacros(storage);
      if (instances.length === 0) {
        // CQL hit but no <ac:structured-macro ac:name="deck|card"> in storage
        // — likely a Cloud-native card or already-converted page.
        return;
      }

      const macroPlans = [];
      for (const inst of instances) {
        const decision = this.processor.shouldRewrite(inst);
        if (decision.rewrite) {
          const rule = this.processor.mappingRules[inst.name] || {};
          // Compute concrete rename list from intersection of rule and instance params.
          const planRenames = [];
          for (const [from, to] of Object.entries(rule.paramRenames || {})) {
            if (from in (inst.params || {})) {
              planRenames.push({ from, to });
            }
          }
          macroPlans.push({
            macroId: inst.macroId,
            oldName: inst.name,
            newName: rule.newName || null,
            paramRenames: planRenames,
            ancestor: inst.parent_name,
            reason: decision.reason,
            span: inst.span,
            selfClose: inst.selfClose,
          });
        } else {
          macroPlans.push({
            macroId: inst.macroId,
            oldName: inst.name,
            skipped: true,
            skipReason: decision.reason,
            ancestor: inst.parent_name,
            span: inst.span,
          });
          if (inst.name && this.opts.oldCardKeys.concat(["card"]).includes(inst.name)) {
            this.stats.macrosAmbiguousSkipped++;
          }
        }
      }

      const willRewrite = macroPlans.some((m) => !m.skipped);
      if (!willRewrite) {
        this.log(`    "${title}" (${id}): all macros skipped as ambiguous, no plan entry`);
        return;
      }

      this.stats.pagesPlanned++;
      this.stats.macrosToRewrite += macroPlans.filter((m) => !m.skipped).length;

      this.planManager.addPageToPlan(id, {
        cloudPageId: id,
        spaceKey,
        title,
        contentType: storagePage.type || "page",
        currentVersion,
        macros: macroPlans,
        backupPath: null,    // filled in execute phase
        diffPath: null,
        completedVersion: null,
      });
    }, this.opts.concurrency);

    this.planManager.savePlan();
    this.log(`\nPlan saved: ${this.planManager.planFilePath}`);
    this.log(`  Pages planned:        ${this.stats.pagesPlanned}`);
    this.log(`  Macros to rewrite:    ${this.stats.macrosToRewrite}`);
    this.log(`  Ambiguous skipped:    ${this.stats.macrosAmbiguousSkipped}`);
    return this.planManager.planFilePath;
  }

  // ─── PHASE 2: EXECUTE PLAN ─────────────────────────────────────────

  async executePlan(planFilePath) {
    if (planFilePath) {
      this.planManager.loadPlan(planFilePath);
    }
    if (!this.planManager.plan) {
      this.planManager.loadPlan();
    }
    if (!this.planManager.plan) {
      throw new Error("No plan loaded. Run with --plan-only first or pass --plan-file.");
    }

    const pages = this.planManager.getPagesToProcess(this.opts.retryFailed);
    this.log(`\nExecuting plan: ${pages.length} page(s) ${this.opts.dryRun ? "[DRY RUN]" : ""}`);
    if (pages.length === 0) {
      this.log("  Nothing to do.");
      return;
    }

    await this.runPool(pages, async ([pageId, data]) => {
      try {
        await this._executePage(pageId, data);
      } catch (e) {
        this.planManager.updatePageStatus(pageId, "failed", e.message);
        this.stats.pagesFailed++;
        this.log(`    "${data.title}" (Cloud: ${pageId}): ERROR - ${e.message}`);
      }
    }, this.opts.concurrency);

    this.planManager.savePlan();
    this.log(`\nExecute complete:`);
    this.log(`  Pages updated:        ${this.stats.pagesUpdated}`);
    this.log(`  Pages skipped:        ${this.stats.pagesSkipped}`);
    this.log(`  Pages failed:         ${this.stats.pagesFailed}`);
    this.log(`  Macros rewritten:     ${this.stats.macrosRewritten}`);
  }

  async _executePage(pageId, data) {
    const { title, currentVersion: plannedVersion, macros: plannedMacros } = data;

    // Re-fetch fresh storage so the rewrite is applied to the current page,
    // not the storage we saw at plan time.
    const sp = await this.cloudClient.getPageStorage(pageId);
    const storage = sp.body?.storage?.value || "";
    const freshVersion = sp.version?.number;
    if (!storage || !freshVersion) {
      this.planManager.updatePageStatus(pageId, "failed", "empty-storage-or-version");
      this.stats.pagesFailed++;
      return;
    }

    // Re-derive instances from fresh storage. Stale spans are ignored —
    // we trust the fresh walk to rediscover the same macros (matched by
    // macroId) as long as nobody else edited the page in a way that
    // dropped them.
    const freshInstances = this.processor.findCandidateMacros(storage);

    // Filter to only those that were plan-accepted AND still match by
    // macroId (stable across version bumps). Self-closing or null-id
    // macros fall back to ordinal alignment — preserve order from the
    // plan and the fresh list.
    const accepted = plannedMacros.filter((m) => !m.skipped);
    const instancesToUse = [];
    let ordinalIdx = 0;
    for (const planned of accepted) {
      let matched = null;
      if (planned.macroId) {
        matched = freshInstances.find(
          (fi) => fi.macroId === planned.macroId && fi.name === planned.oldName,
        );
      }
      if (!matched) {
        // Ordinal fallback — find the next instance with the same name
        for (let k = ordinalIdx; k < freshInstances.length; k++) {
          if (freshInstances[k].name === planned.oldName) {
            matched = freshInstances[k];
            ordinalIdx = k + 1;
            break;
          }
        }
      } else {
        ordinalIdx = freshInstances.indexOf(matched) + 1;
      }
      if (matched) instancesToUse.push(matched);
    }

    if (instancesToUse.length === 0) {
      this.planManager.updatePageStatus(pageId, "skipped", "no-matching-instances-in-fresh-storage");
      this.stats.pagesSkipped++;
      this.log(`    "${title}" (Cloud: ${pageId}): no matching instances; page may have been independently edited`);
      return;
    }

    const { newXml, changes, skipped } = this.processor.rewriteStorage(
      storage,
      instancesToUse,
    );

    if (newXml === storage) {
      this.planManager.updatePageStatus(pageId, "skipped", "no-op");
      this.stats.pagesSkipped++;
      this.log(`    "${title}" (Cloud: ${pageId}): no-op (already converted?)`);
      return;
    }

    // Backups (always written before PUT so a failed PUT still leaves a
    // local snapshot). Skip only if --no-backup was passed.
    let backupPath = null;
    let diffPath = null;
    let metaPath = null;
    if (!this.opts.noBackup) {
      backupPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.xhtml`);
      diffPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.diff.patch`);
      metaPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.meta.json`);
      try {
        if (!fs.existsSync(backupPath)) {
          fs.writeFileSync(backupPath, storage, "utf8");
        }
        const diff = this.processor.unifiedDiff(storage, newXml);
        if (!fs.existsSync(diffPath)) {
          fs.writeFileSync(diffPath, diff, "utf8");
        }
        if (!fs.existsSync(metaPath)) {
          fs.writeFileSync(metaPath, JSON.stringify({
            cloudPageId: pageId,
            spaceKey: data.spaceKey,
            title: title,
            plannedVersion,
            currentVersion: freshVersion,
            postPutVersion: freshVersion + 1,
            runId: this.planManager.plan?.runId || null,
            sha1Before: crypto.createHash("sha1").update(storage).digest("hex"),
            sha1After: crypto.createHash("sha1").update(newXml).digest("hex"),
            changesCount: changes.length,
            skippedCount: skipped.length,
          }, null, 2), "utf8");
        }
      } catch (e) {
        this.log(`    "${title}" (Cloud: ${pageId}): backup write failed: ${e.message} (proceeding anyway)`);
      }
    }

    if (this.opts.dryRun) {
      // Do NOT change page status — dry-run is a preview, leaving the
      // status as "pending" lets the same plan file be re-executed with
      // --execute-only when you're ready to apply.
      this.stats.pagesUpdated++;
      this.stats.macrosRewritten += changes.length;
      this.log(`    [DRY RUN] "${title}" (Cloud: ${pageId}): would rewrite ${changes.length} macro(s); diff at ${diffPath}`);
      return;
    }

    const result = await this.cloudClient.updatePageStorage(
      pageId,
      sp.title,
      sp.type || data.contentType || "page",
      newXml,
      freshVersion,
      this.opts.versionMessage,
    );

    if (result.success) {
      // Use the server-truth new version returned by updatePageStorage. This
      // matters when a 409 retry inside the cloud client raced a third-party
      // edit: the actual post-PUT version is freshVersion + 2 (or more), not
      // freshVersion + 1. Recording the truth here means
      // `restore_composition_tabs.js` computes prevVersion = N+1 (which is
      // the third-party edit) rather than N (which would silently overwrite
      // their work on rollback). Falls back conservatively to freshVersion+1
      // if the API response didn't include a version (defensive).
      const completedVersion = (typeof result.newVersion === "number" && result.newVersion > freshVersion)
        ? result.newVersion
        : freshVersion + 1;
      this.planManager.plan.pages[pageId].completedVersion = completedVersion;
      this.planManager.plan.pages[pageId].backupPath = backupPath
        ? path.relative(this.scriptRoot, backupPath)
        : null;
      this.planManager.plan.pages[pageId].diffPath = diffPath
        ? path.relative(this.scriptRoot, diffPath)
        : null;
      this.planManager.updatePageStatus(pageId, "completed");
      this.stats.pagesUpdated++;
      this.stats.macrosRewritten += changes.length;
      const conflictNote = completedVersion > freshVersion + 1
        ? ` (post-409 actual version: ${completedVersion})`
        : "";
      this.log(`    "${title}" (Cloud: ${pageId}): rewrote ${changes.length} macro(s)${conflictNote}`);
    } else {
      this.planManager.updatePageStatus(pageId, "failed", result.error);
      this.stats.pagesFailed++;
      this.log(`    "${title}" (Cloud: ${pageId}): FAILED - ${result.error}`);
    }
  }

  // ─── VERIFICATION ─────────────────────────────────────────────────

  async verifyAfter() {
    if (!this.opts.verifyAfter) return;
    this.log("\nStep 4: Post-run verification...");

    const oldDeckKeys = this.opts.oldDeckKeys.length ? this.opts.oldDeckKeys : ["deck"];
    const oldCardKeys = this.opts.oldCardKeys.length ? this.opts.oldCardKeys : ["card"];
    const oldQuoted = [...new Set([...oldDeckKeys, ...oldCardKeys])]
      .map((k) => `"${k}"`).join(",");
    const newQuoted = `"tab-group","tab"`;

    const spaceClause = this.opts.spaceKeys.length > 0
      ? `space in (${this.opts.spaceKeys.map((k) => `"${k}"`).join(",")}) AND `
      : "";

    const residualCql = `${spaceClause}macro in (${oldQuoted}) AND type = page`;
    const landedCql = `${spaceClause}macro in (${newQuoted}) AND type = page`;

    let residual = 0, landed = 0;
    await this.cloudClient.searchContentByCql(residualCql, "version", async (results) => {
      residual += results.length;
    });
    await this.cloudClient.searchContentByCql(landedCql, "version", async (results) => {
      landed += results.length;
    });

    this.log(`  Residual deck/card pages: ${residual} (CQL: ${residualCql})`);
    this.log(`  Landed tab-group/tab pages: ${landed}`);
    if (residual > this.stats.macrosAmbiguousSkipped + this.stats.pagesFailed) {
      this.log(`  WARNING: residual count exceeds (ambiguous + failures); investigate the offending pages.`);
    }
  }

  // ─── ENTRY ────────────────────────────────────────────────────────

  async run() {
    await this.testConnection();

    if (this.opts.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      this.planManager.loadPlan(this.opts.planFile);
      if (!this.planManager.plan) {
        throw new Error("No plan found. Run --plan-only first or pass --plan-file.");
      }
      this.log("\nStep 3: Executing plan...");
      await this.executePlan();
    } else {
      this.log("\nStep 2: Building plan...");
      const planPath = await this.buildPlan();
      if (this.opts.planOnly) {
        this.log(`\nPLAN-ONLY MODE: stopping. Plan at ${planPath}`);
        return;
      }
      this.log("\nStep 3: Executing plan...");
      await this.executePlan();
    }

    await this.verifyAfter();
  }
}

// ─────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }

  let sync = null;
  const shutdown = () => {
    if (sync && sync.planManager && sync.planManager.plan) {
      console.log("\nShutting down gracefully...");
      try {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      } catch (e) {
        console.error(`Plan save failed: ${e.message}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    sync = new CompositionTabsSync(opts);
    await sync.run();
    console.log("\nDone.");
    process.exit(0);
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    if (sync && sync.planManager && sync.planManager.plan) {
      try {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      } catch (_) { /* ignore */ }
    }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { CompositionTabsSync, parseArgs };
