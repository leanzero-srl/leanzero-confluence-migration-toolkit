#!/usr/bin/env node

/**
 * Sync Nested Macros: un-nest nested bodied macros across a Confluence Cloud space.
 *
 * Confluence Cloud's Fabric editor does not support nested bodied macros (NBMs).
 * After DC→Cloud migration or manual authoring, pages containing macro-in-macro
 * structures render incorrectly and the editor errors with
 * `confluenceADFMigrationUnsupportedContentInternalExtension`.
 *
 * This script:
 *   Phase 1 (Plan):    Scans Cloud via CQL for pages containing candidate bodied
 *                      macros; for each, fetches storage format, walks the tree,
 *                      records any nestings, and saves a JSON plan.
 *   Phase 2 (Execute): Loads the plan and rewrites each planned page so that
 *                      previously-nested macros become siblings (split-around-child
 *                      strategy). Excluded layout containers (column/section/...)
 *                      fall back per --fallback-strategy.
 *
 * Usage:
 *   node main/sync_nested_macros.js [options]
 *
 * See --help for the full option list.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");
const sfp = require("../src/storageFormatParser");
const detector = require("../src/nestedMacroDetector");
const processor = require("../src/unnestProcessor");

// Default candidate bodied macros to search via CQL. A page matching any of
// these is a candidate for nesting; we still parse the body to confirm.
const DEFAULT_CANDIDATE_MACROS = [
  "expand",
  "info",
  "warning",
  "note",
  "tip",
  "panel",
  "details",
  "excerpt",
  "column",
  "section",
  "layout",
  "status",
];

// Excluded containers — cannot be split around children without breaking
// their structural semantics. Subject to --fallback-strategy.
// Keep in sync with src/unnestProcessor.js DEFAULT_EXCLUDED.
const DEFAULT_EXCLUDED_CONTAINERS = [
  "column", "section", "layout", "details", "tabs-group", "tabs",
  "table", "tr", "td", "div",
  "show-if", "hide-if",
];

class NestedMacroSync {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 3,
      retryFailed: options.retryFailed || false,
      spaceKeys: options.spaceKeys || [],
      all: options.all || false,
      candidateMacros: options.candidateMacros || DEFAULT_CANDIDATE_MACROS,
      excludedContainers: new Set(options.excludedContainers || DEFAULT_EXCLUDED_CONTAINERS),
      fallbackStrategy: options.fallbackStrategy || "skip",
    };

    this.validateConfig();

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync Nested Macros Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, this.log);
    if (this.options.planFile) this.planManager.setPlanFile(this.options.planFile);

    this.startTime = Date.now();

    this.stats = {
      spacesQueried: 0,
      pagesSearched: 0,
      pagesParsed: 0,
      pagesWithNestings: 0,
      pagesFixable: 0,
      pagesUnfixable: 0,
      pagesUpdated: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      totalFindings: 0,
      parseErrors: 0,
    };
  }

  validateConfig() {
    const required = ["CLOUD_BASE_URL", "CLOUD_EMAIL", "CLOUD_API_TOKEN"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\n` +
          "Copy .env.example to .env and fill in the values.",
      );
    }
    if (!this.options.all && this.options.spaceKeys.length === 0) {
      throw new Error("Specify --space <KEY> (repeatable) or --all.");
    }
    if (!["skip", "promote", "fail"].includes(this.options.fallbackStrategy)) {
      throw new Error(`Invalid --fallback-strategy: ${this.options.fallbackStrategy}`);
    }
  }

  log(message) {
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* ignore log write failures */ }
  }

  async run() {
    this.log("==============================================");
    this.log("Sync Nested Macros — Confluence Cloud");
    this.log("==============================================");
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);

    if (this.options.dryRun) this.log("*** DRY RUN MODE — no changes will be made ***");
    if (this.options.limit > 0) this.log(`  Page limit: ${this.options.limit}`);
    if (this.options.spaceKeys.length > 0) this.log(`  Spaces: ${this.options.spaceKeys.join(", ")}`);
    if (this.options.all) this.log(`  Scope: ALL spaces`);
    this.log(`  Mode: ${this.options.planOnly ? "PLAN ONLY" : this.options.executeOnly ? "EXECUTE ONLY" : "FULL (plan + execute)"}`);
    this.log(`  Concurrency: ${this.options.concurrency}`);
    this.log(`  Fallback strategy: ${this.options.fallbackStrategy}`);
    this.log(`  Candidate macros: ${this.options.candidateMacros.join(", ")}`);
    this.log(`  Excluded containers: ${[...this.options.excludedContainers].join(", ")}`);
    if (this.options.retryFailed) this.log(`  Retry failed: YES`);
    this.log("");

    this.log("Step 1: Testing Cloud connection...");
    const ok = await this.cloudClient.testConnection();
    if (!ok) throw new Error("Cannot connect to Confluence Cloud");
    this.log("  Cloud: OK\n");

    if (this.options.executeOnly) {
      this.log("Step 2: Loading existing plan...");
      const plan = this.planManager.loadPlan(this.options.planFile);
      if (!plan) throw new Error("No plan found. Run without --execute-only first to build a plan.");
    } else {
      const runId = String(Date.now());
      this.log("Step 2: Scanning Cloud for nested macros and building plan...");
      this.planManager.createPlan(runId);
      await this.buildPlan();

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY MODE — skipping execution ***");
        this.planManager.savePlan();
        this.printReport();
        return;
      }
    }

    this.log(`\nStep 3: Executing plan (${this.planManager.plan.stats.pending} pending pages)...`);
    await this.executePlan();

    this.planManager.savePlan();
    this.printReport();
  }

  // ─── Plan building ───────────────────────────────────────────────

  async buildPlan() {
    const spaceKeys = this.options.all ? [null] : this.options.spaceKeys;
    for (const spaceKey of spaceKeys) {
      if (this.options.limit > 0 && this.stats.pagesParsed >= this.options.limit) break;
      await this.scanSpace(spaceKey);
    }
    this.planManager.savePlan();
    this.log(`\n  Scan complete. Pages scanned: ${this.stats.pagesSearched}. Pages with nestings: ${this.stats.pagesWithNestings}.`);
  }

  buildCql(spaceKey) {
    const macroList = this.options.candidateMacros.map((m) => `"${m}"`).join(",");
    const spaceClause = spaceKey ? ` AND space="${spaceKey}"` : "";
    return `type=page AND macro in (${macroList})${spaceClause}`;
  }

  async scanSpace(spaceKey) {
    const label = spaceKey || "(all spaces)";
    this.log(`\n  Scanning ${label}...`);
    this.stats.spacesQueried++;

    const cql = this.buildCql(spaceKey);
    await this.cloudClient.searchContentByCql(
      cql,
      "body.storage,version,space",
      async (pages) => {
        this.stats.pagesSearched += pages.length;
        for (const page of pages) {
          if (this.options.limit > 0 && this.stats.pagesParsed >= this.options.limit) return false;
          await this.inspectPage(page);
        }
        return true;
      },
    );
  }

  async inspectPage(page) {
    this.stats.pagesParsed++;
    const pageId = page.id || page.content?.id;
    const title = page.title || page.content?.title;
    const spaceKey = page.space?.key || page.content?.space?.key;
    const version = page.version?.number || page.content?.version?.number;
    const storage = page.body?.storage?.value || page.content?.body?.storage?.value;

    if (!pageId || typeof storage !== "string") return;

    let tree;
    try {
      tree = sfp.parse(storage);
    } catch (err) {
      this.stats.parseErrors++;
      this.log(`    [parse-error] ${pageId} "${title}": ${err.message}`);
      return;
    }

    const findings = detector.detect(tree);
    if (findings.length === 0) return;

    this.stats.pagesWithNestings++;
    this.stats.totalFindings += findings.length;

    // Check whether any finding is inside an excluded container whose
    // fallback is "fail" — if so, the page is unfixable (for a "fail"
    // strategy at run time).
    //
    // Use semanticHash (sha1 of serialise(parse(storage))) rather than a
    // raw sha1 of `storage` so that the no-op skip at execute time can
    // actually fire. The parser is not byte-stable across self-closing
    // tag forms (e.g. `<br/>` vs `<br></br>`), so afterHash — which is
    // computed from serialise(tree) — will only ever match a beforeHash
    // computed the same way.
    const beforeHash = sfp.semanticHash(storage);
    this.planManager.addPageToPlan(pageId, {
      status: "pending",
      spaceKey,
      title,
      version,
      nestings: findings.map((f) => ({
        outerMacro: f.outerMacro,
        innerMacro: f.innerMacro,
        depth: f.depth,
        path: f.path,
        strategy: this.options.excludedContainers.has(f.outerMacro)
          ? this.options.fallbackStrategy
          : "split",
      })),
      beforeHash,
    });

    if (this.stats.pagesWithNestings % 25 === 0) {
      this.log(
        `    ...${this.stats.pagesWithNestings} affected pages so far (${this.stats.totalFindings} findings)`,
      );
    }
  }

  // ─── Plan execution ──────────────────────────────────────────────

  async executePlan() {
    const pending = this.planManager.getPagesToProcess(this.options.retryFailed);
    if (pending.length === 0) {
      this.log("  No pages to process.");
      return;
    }

    let cursor = 0;
    const total = pending.length;
    const workers = [];

    const next = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= total) return;
        const [pageId, pageData] = pending[idx];
        await this.processOne(pageId, pageData, idx + 1, total);
        if (idx % 50 === 49) this.planManager.savePlan();
      }
    };

    for (let w = 0; w < this.options.concurrency; w++) workers.push(next());
    await Promise.all(workers);
  }

  async processOne(pageId, planEntry, ordinal, total) {
    // On 409 we refetch the page, re-detect, re-un-nest, and PUT again —
    // overlaying our transformation onto whatever the concurrent editor
    // wrote, instead of clobbering their bytes with our stale body.
    const MAX_CONFLICT_RETRIES = 2;
    let conflictAttempt = 0;

    while (true) {
      try {
        // Always re-fetch to get latest version and storage. On 409 retry
        // this is the whole point — we MUST see the conflicting writer's
        // bytes before we re-derive our PUT.
        const page = await this.cloudClient.getPageWithStorage(pageId);
        const title = page.title || planEntry.title;
        const storage = page.body?.storage?.value;
        const version = page.version?.number;

        if (typeof storage !== "string") {
          this.stats.pagesFailed++;
          this.planManager.updatePageStatus(pageId, "failed", {
            error: "No storage body returned",
          });
          this.log(`  [${ordinal}/${total}] FAIL ${pageId} "${title}": no storage body`);
          return;
        }

        let tree;
        try {
          tree = sfp.parse(storage);
        } catch (err) {
          this.stats.pagesFailed++;
          this.planManager.updatePageStatus(pageId, "failed", { error: `Parse error: ${err.message}` });
          this.log(`  [${ordinal}/${total}] FAIL ${pageId} "${title}": ${err.message}`);
          return;
        }

        // If detection says no nestings remain (concurrent editor or earlier
        // run already fixed it), mark as skipped.
        const findings = detector.detect(tree);
        if (findings.length === 0) {
          this.stats.pagesSkipped++;
          this.planManager.updatePageStatus(pageId, "skipped", { error: null });
          this.log(`  [${ordinal}/${total}] SKIP ${pageId} "${title}": no nestings found`);
          return;
        }

        const { stats: unnestStats, unfixable } = processor.unnest(tree, {
          excludedContainers: this.options.excludedContainers,
          fallbackStrategy: this.options.fallbackStrategy,
        });

        if (unfixable && this.options.fallbackStrategy === "fail") {
          this.stats.pagesUnfixable++;
          this.planManager.updatePageStatus(pageId, "unfixable", {
            error: "Has nestings inside excluded containers with --fallback-strategy=fail",
          });
          this.log(`  [${ordinal}/${total}] UNFIXABLE ${pageId} "${title}"`);
          return;
        }

        // Re-check: any structural nestings remaining post-unnest (if skip
        // strategy left excluded-container nestings, they'll be here). We
        // update anyway — the split that *did* happen is still progress.
        const remaining = detector.detect(tree);
        const newStorage = sfp.serialize(tree);
        const afterHash = crypto.createHash("sha1").update(newStorage).digest("hex");

        // Skip PUT if the un-nest produced no semantic change. We compare
        // against semanticHash(storage) — the hash of the freshly fetched
        // storage parsed-then-serialised — so the parser's non-byte-stable
        // round-trip (e.g. self-closing tag normalisation) doesn't masquerade
        // as a real edit.
        const freshSemanticHash = sfp.semanticHash(storage);
        if (afterHash === freshSemanticHash) {
          this.stats.pagesSkipped++;
          this.planManager.updatePageStatus(pageId, "skipped", {
            error: "No-op: unnest produced identical content",
            afterHash,
          });
          this.log(`  [${ordinal}/${total}] SKIP ${pageId} "${title}": no-op`);
          return;
        }

        if (this.options.dryRun) {
          this.stats.pagesUpdated++;
          this.planManager.updatePageStatus(pageId, "completed", {
            error: null,
            afterHash,
            version,
          });
          this.log(
            `  [${ordinal}/${total}] DRY ${pageId} "${title}": ${unnestStats.changes} splits, ${remaining.length} remaining (excluded)`,
          );
          return;
        }

        const result = await this.cloudClient.updatePageStorage(
          pageId,
          title,
          newStorage,
          version,
        );

        if (result.success) {
          this.stats.pagesUpdated++;
          this.planManager.updatePageStatus(pageId, "completed", {
            error: null,
            afterHash,
            version: version + 1,
          });
          this.log(
            `  [${ordinal}/${total}] OK ${pageId} "${title}": ${unnestStats.changes} splits, ${remaining.length} remaining (excluded)` +
              (conflictAttempt > 0 ? ` (after ${conflictAttempt} 409 retries)` : ""),
          );
          return;
        }

        // ── 409 version conflict — refetch, re-detect, re-un-nest, retry ──
        if (result.statusCode === 409 && conflictAttempt < MAX_CONFLICT_RETRIES) {
          conflictAttempt++;
          this.log(
            `  [${ordinal}/${total}] 409 ${pageId} "${title}": concurrent edit detected, refetching (attempt ${conflictAttempt}/${MAX_CONFLICT_RETRIES})`,
          );
          continue; // restart the entire fetch → process → PUT cycle
        }

        // Terminal PUT failure (non-409, or 409 budget exhausted)
        this.stats.pagesFailed++;
        this.planManager.updatePageStatus(pageId, "failed", { error: result.error });
        this.log(`  [${ordinal}/${total}] FAIL ${pageId} "${title}": ${result.error}`);
        return;
      } catch (err) {
        this.stats.pagesFailed++;
        this.planManager.updatePageStatus(pageId, "failed", { error: err.message });
        this.log(`  [${ordinal}/${total}] FAIL ${pageId}: ${err.message}`);
        return;
      }
    }
  }

  // ─── Reporting ───────────────────────────────────────────────────

  printReport() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const cloudStats = this.cloudClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) this.log("*** DRY RUN — no changes were written ***\n");

    this.log("Scan:");
    this.log(`  Spaces queried:         ${this.stats.spacesQueried}`);
    this.log(`  Pages searched:         ${this.stats.pagesSearched}`);
    this.log(`  Pages parsed:           ${this.stats.pagesParsed}`);
    this.log(`  Parse errors:           ${this.stats.parseErrors}`);
    this.log(`  Pages with nestings:    ${this.stats.pagesWithNestings}`);
    this.log(`  Total nesting findings: ${this.stats.totalFindings}`);

    this.log("\nExecute:");
    this.log(`  Pages updated:   ${this.stats.pagesUpdated}`);
    this.log(`  Pages failed:    ${this.stats.pagesFailed}`);
    this.log(`  Pages skipped:   ${this.stats.pagesSkipped}`);
    this.log(`  Pages unfixable: ${this.stats.pagesUnfixable}`);

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total:      ${planSummary.total}`);
      this.log(`  Completed:  ${planSummary.completed}`);
      this.log(`  Failed:     ${planSummary.failed}`);
      this.log(`  Pending:    ${planSummary.pending}`);
      this.log(`  Skipped:    ${planSummary.skipped}`);
      this.log(`  Unfixable:  ${planSummary.unfixable}`);
      this.log(`  Plan file:  ${planSummary.planFile || "N/A"}`);
    }

    this.log("\nAPI Statistics:");
    this.log(
      `  Cloud requests:  ${cloudStats.requestCount} (${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits)`,
    );
    this.log(`\nTotal elapsed: ${elapsed}s`);
    this.log(`Log file:      ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Sync Nested Macros — Confluence Cloud

Scan Cloud for pages with nested bodied macros and un-nest them using the
split-around-child strategy. Preserves all content; only structural nesting
changes. Reuses the plan+execute pattern from html-macro and visibility-macro.

Usage:
  node sync_nested_macros.js [options]

Plan phase:
  --space <KEY>                  Space key (repeatable or comma-separated)
  --all                          Scan all spaces
  --limit <N>                    Cap total pages processed
  --candidate-macros <list>      Comma-separated CQL macro filter list
  --excluded-containers <list>   Comma-separated non-splittable macro list
  --fallback-strategy <mode>     skip | promote | fail  (default: skip)
  --plan-only                    Build plan, do not execute

Execute phase:
  --execute-only, --resume       Load an existing plan and execute
  --plan-file <path>             Plan JSON to load (default: latest in logs/)
  --retry-failed                 Reprocess pages marked failed
  --concurrency <N>              Parallel PUT workers (default: 3)
  --dry-run                      Simulate writes, no actual PUT

Other:
  --help                         Show this message

Environment (.env):
  CLOUD_BASE_URL    Confluence Cloud base URL (must include /wiki)
  CLOUD_EMAIL       Cloud user email
  CLOUD_API_TOKEN   Cloud API token

Examples:
  # Plan-only scan of a single space
  node main/sync_nested_macros.js --plan-only --space PROJ

  # Dry run to see what would change
  node main/sync_nested_macros.js --dry-run --space PROJ --limit 5

  # Resume an existing plan
  node main/sync_nested_macros.js --execute-only --plan-file ./logs/plan_123.json

  # Full scan with promote fallback for layout containers
  node main/sync_nested_macros.js --space PROJ --fallback-strategy promote
`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { spaceKeys: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
        NestedMacroSync.showHelp();
        process.exit(0);
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--space": {
        const val = args[++i];
        if (val) {
          const keys = val.split(",").map((k) => k.trim()).filter(Boolean);
          options.spaceKeys.push(...keys);
        }
        break;
      }
      case "--limit":
        options.limit = parseInt(args[++i], 10) || 0;
        break;
      case "--plan-only":
        options.planOnly = true;
        break;
      case "--execute-only":
      case "--resume":
        options.executeOnly = true;
        break;
      case "--plan-file":
        options.planFile = args[++i];
        break;
      case "--concurrency":
        options.concurrency = parseInt(args[++i], 10) || 3;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--candidate-macros": {
        const val = args[++i];
        if (val) options.candidateMacros = val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--excluded-containers": {
        const val = args[++i];
        if (val) options.excludedContainers = val.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--fallback-strategy":
        options.fallbackStrategy = args[++i];
        break;
      default:
        if (arg.startsWith("--")) console.warn(`Unknown option: ${arg}`);
        break;
    }
  }

  return options;
}

async function main() {
  let sync = null;

  const shutdown = () => {
    if (sync && sync.planManager && sync.planManager.plan) {
      console.log("\nShutting down gracefully...");
      sync.planManager.savePlan();
      console.log(`Plan saved: ${sync.planManager.planFilePath}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    sync = new NestedMacroSync(options);
    await sync.run();
    console.log("\nSync completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    if (sync && sync.planManager && sync.planManager.plan) {
      sync.planManager.savePlan();
      console.log(`Plan saved: ${sync.planManager.planFilePath}`);
    }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = NestedMacroSync;
