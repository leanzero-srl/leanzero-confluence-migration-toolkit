#!/usr/bin/env node

/**
 * Restore scaffolding-style show-if/hide-if macros that were incorrectly
 * converted to Forge "Visibility - Show If" ecosystem bodiedExtensions by
 * an earlier sync_visibility_macros.js run.
 *
 * Discovery walks a SOURCE plan (the previous sync run that did the damage,
 * e.g. logs/plan_1778311380618.json). For each page that completed:
 *   1. Fetch DC storage.
 *   2. Classify each show-if/hide-if macro via VMP._classifyDcMacro.
 *   3. Record any that classify as "scaffolding" — those need restoring.
 *
 * Execute fetches each Cloud page, finds the Forge-ecosystem visibility
 * bodiedExtensions whose macroId matches a "to restore" entry, and rewrites
 * node.attrs back to the legacy bodiedExtension shape via VMP._applyLegacyAttrs.
 *
 *   --plan-only --source-plan <path>     build restore plan, no Cloud writes
 *   --execute-only --plan-file <path>    apply an existing restore plan
 *   --concurrency <n>                    parallel page workers (default 5)
 *   --limit <n>                          cap pages processed in plan phase
 *   --dry-run                            execute path simulates only
 *   --space <KEY[,KEY...]>               filter source-plan pages by space
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const VisibilityMacroProcessor = require("../src/visibilityMacroProcessor");

function parseArgs(argv) {
  const opts = {
    planOnly: false,
    executeOnly: false,
    sourcePlan: null,
    planFile: null,
    concurrency: 5,
    limit: 0,
    dryRun: false,
    spaceFilter: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan-only": opts.planOnly = true; break;
      case "--execute-only": case "--resume": opts.executeOnly = true; break;
      case "--source-plan": opts.sourcePlan = argv[++i]; break;
      case "--plan-file": opts.planFile = argv[++i]; break;
      case "--concurrency": opts.concurrency = parseInt(argv[++i], 10) || 5; break;
      case "--limit": opts.limit = parseInt(argv[++i], 10) || 0; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--space": opts.spaceFilter = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean); break;
      case "--help": case "-h": opts.help = true; break;
    }
  }
  return opts;
}

function help() {
  console.log(`
Usage: node main/restore_scaffolding.js [options]

  --plan-only --source-plan <path>     Build restore plan from a sync plan
  --execute-only --plan-file <path>    Apply an existing restore plan
  --space <KEY[,KEY...]>               Filter source-plan pages by space
  --concurrency <n>                    Default 5
  --limit <n>                          Cap pages processed (plan phase)
  --dry-run                            Execute path simulates writes only
  --help                               This help

Examples:
  # Build restore plan from May 9 sync plan
  node main/restore_scaffolding.js --plan-only --source-plan logs/plan_1778311380618.json

  # Dry-run a single space
  node main/restore_scaffolding.js --plan-only --source-plan logs/plan_1778311380618.json --space glossary --limit 5

  # Apply restore
  node main/restore_scaffolding.js --execute-only --plan-file logs/restore_plan_<id>.json
  `);
}

class ScaffoldingRestore {
  constructor(opts) {
    this.opts = opts;
    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.logFile = path.join(this.logDir, `restore_${Date.now()}.log`);
    fs.writeFileSync(this.logFile, `Restore Scaffolding Macros Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`);

    this.dcClient = new DatacenterConfluenceClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      { pat: process.env.DC_PAT },
    );
    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );
    this.proc = new VisibilityMacroProcessor(
      this.dcClient,
      this.cloudClient,
      null,
      null,
      { macroNames: ["show-if", "hide-if"], log: (m) => this.log(m) },
    );

    this.stats = {
      sourcePagesScanned: 0,
      sourcePagesEligible: 0,
      dcFetchErrors: 0,
      pagesPlanned: 0,
      macrosToRestore: 0,
      pagesUpdated: 0,
      pagesSkippedNoChange: 0,
      pagesFailed: 0,
      macrosRestoredTotal: 0,
      macrosAlreadyLegacy: 0,
    };
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try { fs.appendFileSync(this.logFile, line + "\n"); } catch (_) {}
  }

  async testConnections() {
    this.log("Step 1: Testing connections...");
    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) throw new Error("DC connection failed");
    this.log("  Datacenter: OK");
    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) throw new Error("Cloud connection failed");
    this.log("  Cloud: OK");
  }

  async runPool(items, workerFn, concurrency) {
    let idx = 0;
    const total = items.length;
    let done = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = idx++;
        if (i >= total) return;
        try { await workerFn(items[i], i); } catch (e) { this.log(`  worker error: ${e.message}`); }
        done++;
        if (done % 100 === 0) this.log(`  Progress: ${done}/${total}`);
      }
    });
    await Promise.all(workers);
  }

  // ─────────────────────────────────────────────────────────────────
  //  PHASE 1: BUILD RESTORE PLAN
  // ─────────────────────────────────────────────────────────────────

  async buildPlan() {
    if (!this.opts.sourcePlan) throw new Error("--source-plan <path> is required for plan phase");
    if (!fs.existsSync(this.opts.sourcePlan)) throw new Error(`Source plan not found: ${this.opts.sourcePlan}`);

    this.log(`\nStep 2: Reading source plan ${this.opts.sourcePlan}...`);
    const source = JSON.parse(fs.readFileSync(this.opts.sourcePlan, "utf8"));
    let candidates = Object.values(source.pages || {})
      .filter((p) => p.status === "completed" && p.dcPageId);
    if (this.opts.spaceFilter && this.opts.spaceFilter.length > 0) {
      const set = new Set(this.opts.spaceFilter);
      candidates = candidates.filter((p) => set.has(p.spaceKey));
    }
    if (this.opts.limit > 0) candidates = candidates.slice(0, this.opts.limit);
    this.log(`  Eligible pages from source plan: ${candidates.length}`);
    this.stats.sourcePagesScanned = Object.keys(source.pages || {}).length;
    this.stats.sourcePagesEligible = candidates.length;

    const restorePages = {};

    await this.runPool(candidates, async (p) => {
      let dcMacros = [];
      try {
        const dcPage = await this.dcClient.getPageContent(p.dcPageId);
        const body = dcPage.body?.storage?.value || "";
        dcMacros = this.proc.extractDcParamsFromStorage(body);
      } catch (e) {
        this.stats.dcFetchErrors++;
        return;
      }

      // For each DC macro that classifies as scaffolding, record an entry.
      // Use the source plan's per-macro list to know what macroId was
      // stamped onto Cloud during the original run; that's how we'll match
      // Cloud nodes again in the execute phase.
      const sourceMacros = p.macros || [];
      const dcByOrdinal = dcMacros;
      const dcById = new Map();
      for (const m of dcMacros) if (m.macroId) dcById.set(m.macroId, m);

      const toRestore = [];
      for (let i = 0; i < sourceMacros.length; i++) {
        const sm = sourceMacros[i];
        // Match the same way the original sync did:
        const dc = (sm.macroId && dcById.get(sm.macroId)) || dcByOrdinal[i] || null;
        if (!dc) continue;
        const cls = this.proc._classifyDcMacro(dc);
        if (cls !== "scaffolding") continue;
        toRestore.push({
          index: i,
          planMacroId: sm.macroId,    // what Cloud's macroMetadata.macroId.value should be
          macroId: dc.macroId,         // DC's true ac:macro-id
          macroName: dc.macroName,
          params: dc.params,
        });
      }

      if (toRestore.length === 0) return;

      this.stats.pagesPlanned++;
      this.stats.macrosToRestore += toRestore.length;
      restorePages[p.cloudPageId] = {
        cloudPageId: p.cloudPageId,
        dcPageId: p.dcPageId,
        spaceKey: p.spaceKey,
        title: p.title,
        contentType: p.contentType || "page",
        macros: toRestore,
        status: "pending",
        error: null,
        updatedAt: null,
      };
    }, this.opts.concurrency);

    const runId = String(Date.now());
    const plan = {
      version: "1.0",
      runId,
      createdAt: new Date().toISOString(),
      sourcePlan: this.opts.sourcePlan,
      stats: { total: this.stats.pagesPlanned, pending: this.stats.pagesPlanned, completed: 0, failed: 0, skipped: 0 },
      pages: restorePages,
    };
    const planPath = path.join(this.logDir, `restore_plan_${runId}.json`);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    this.log(`\nRestore plan saved: ${planPath}`);
    this.log(`  Pages with macros to restore: ${this.stats.pagesPlanned}`);
    this.log(`  Total macros to restore:      ${this.stats.macrosToRestore}`);
    this.log(`  DC fetch errors:              ${this.stats.dcFetchErrors}`);
    return planPath;
  }

  // ─────────────────────────────────────────────────────────────────
  //  PHASE 2: EXECUTE RESTORE PLAN
  // ─────────────────────────────────────────────────────────────────

  async executePlan() {
    if (!this.opts.planFile) throw new Error("--plan-file <path> is required for execute phase");
    if (!fs.existsSync(this.opts.planFile)) throw new Error(`Plan not found: ${this.opts.planFile}`);

    this.log(`\nStep 2: Loading restore plan ${this.opts.planFile}...`);
    const plan = JSON.parse(fs.readFileSync(this.opts.planFile, "utf8"));
    const pages = Object.values(plan.pages || {}).filter((p) => p.status === "pending" || p.status === "failed");
    this.log(`  Pages to process: ${pages.length}`);
    if (this.opts.dryRun) this.log(`  [DRY RUN] no Cloud writes will be made`);

    const updatedPlanPath = this.opts.planFile;

    await this.runPool(pages, async (p) => {
      try {
        await this._executePage(p);
      } catch (e) {
        p.status = "failed";
        p.error = e.message;
        this.stats.pagesFailed++;
        this.log(`    "${p.title}" (Cloud: ${p.cloudPageId}): ERROR - ${e.message}`);
      }
      // Persist plan progress every 50 pages
      if ((this.stats.pagesUpdated + this.stats.pagesFailed + this.stats.pagesSkippedNoChange) % 50 === 0) {
        try { fs.writeFileSync(updatedPlanPath, JSON.stringify(plan, null, 2)); } catch (_) {}
      }
    }, this.opts.concurrency);

    plan.stats = {
      total: pages.length,
      pending: 0,
      completed: this.stats.pagesUpdated,
      failed: this.stats.pagesFailed,
      skipped: this.stats.pagesSkippedNoChange,
    };
    plan.completedAt = new Date().toISOString();
    fs.writeFileSync(updatedPlanPath, JSON.stringify(plan, null, 2));
    this.log(`\nFinal stats:`);
    this.log(`  Pages updated:             ${this.stats.pagesUpdated}`);
    this.log(`  Pages skipped (no change): ${this.stats.pagesSkippedNoChange}`);
    this.log(`  Pages failed:              ${this.stats.pagesFailed}`);
    this.log(`  Macros restored:           ${this.stats.macrosRestoredTotal}`);
    this.log(`  Macros already legacy:     ${this.stats.macrosAlreadyLegacy}`);
  }

  async _executePage(p) {
    const cloudPageId = p.cloudPageId;
    const pageTitle = p.title;

    let pageWithAdf;
    try {
      pageWithAdf = await this.cloudClient.getPageAdf(cloudPageId);
    } catch (e) {
      throw new Error(`ADF fetch failed: ${e.message}`);
    }

    const pageType = pageWithAdf.type || p.contentType || "page";
    const version = pageWithAdf.version?.number;
    const adfRaw = pageWithAdf.body?.atlas_doc_format?.value;
    if (!adfRaw) throw new Error("no ADF body");
    let adf;
    try { adf = JSON.parse(adfRaw); } catch (e) { throw new Error(`ADF parse failed: ${e.message}`); }

    const nodes = this.proc.collectVisibilityNodes(adf);
    const liveById = new Map();
    for (const n of nodes) {
      const mid = n.node.attrs?.parameters?.macroMetadata?.macroId?.value;
      if (mid) liveById.set(mid, n);
    }

    let mutations = 0;
    let alreadyLegacy = 0;

    for (const restore of p.macros) {
      // Match Cloud node: prefer planMacroId (what May 9 stamped), fallback
      // to ordinal at restore.index.
      let entry = (restore.planMacroId && liveById.get(restore.planMacroId)) || nodes[restore.index] || null;
      if (!entry) continue;
      // Idempotency: if Cloud is already legacy form, nothing to do.
      if (entry.flavor === "legacy") {
        alreadyLegacy++;
        continue;
      }
      const before = JSON.stringify(entry.node.attrs);
      this.proc._applyLegacyAttrs(entry.node, restore);
      const after = JSON.stringify(entry.node.attrs);
      if (before !== after) mutations++;
    }

    if (mutations === 0) {
      p.status = alreadyLegacy > 0 ? "completed" : "skipped";
      p.error = alreadyLegacy > 0 ? `${alreadyLegacy} macro(s) already legacy` : "Nothing changed";
      p.updatedAt = new Date().toISOString();
      this.stats.pagesSkippedNoChange++;
      this.stats.macrosAlreadyLegacy += alreadyLegacy;
      this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): ${alreadyLegacy} already legacy, nothing to write`);
      return;
    }

    if (this.opts.dryRun) {
      this.log(`    [DRY RUN] "${pageTitle}" (Cloud: ${cloudPageId}): would restore ${mutations} macro(s)`);
      // Don't mutate plan status on dry-run; allows the same plan to be
      // re-executed for real later.
      this.stats.pagesUpdated++;
      this.stats.macrosRestoredTotal += mutations;
      return;
    }

    const result = await this.cloudClient.updatePageAdf(
      cloudPageId,
      pageTitle,
      pageType,
      adf,
      version,
    );
    if (result.success) {
      p.status = "completed";
      p.error = null;
      p.updatedAt = new Date().toISOString();
      this.stats.pagesUpdated++;
      this.stats.macrosRestoredTotal += mutations;
      this.stats.macrosAlreadyLegacy += alreadyLegacy;
      this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): restored ${mutations} macro(s)${alreadyLegacy?` (+${alreadyLegacy} already legacy)`:""}`);
    } else {
      p.status = "failed";
      p.error = result.error;
      this.stats.pagesFailed++;
      this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): FAILED - ${result.error}`);
    }
  }

  async run() {
    await this.testConnections();
    if (this.opts.executeOnly) {
      await this.executePlan();
    } else if (this.opts.planOnly) {
      await this.buildPlan();
    } else {
      throw new Error("Specify --plan-only or --execute-only");
    }
  }
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }
  if (!opts.planOnly && !opts.executeOnly) { help(); process.exit(1); }
  try {
    const r = new ScaffoldingRestore(opts);
    await r.run();
    console.log("\nDone.");
  } catch (e) {
    console.error("\nFATAL:", e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
})();
