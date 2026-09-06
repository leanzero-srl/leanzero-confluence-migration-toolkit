#!/usr/bin/env node

/**
 * Sync HTML Macros: Confluence Datacenter -> Cloud
 *
 * Two-phase architecture:
 *   Phase 1 (Plan):   Scan DC pages for HTML macros, extract content, match Cloud pages
 *   Phase 2 (Execute): Replace broken HTML macro blocks in Cloud with DC content
 *
 * When pages are migrated from DC to Cloud, HTML macros often break because the
 * HTML macro app is unavailable or behaves differently. This script extracts the
 * raw HTML from DC macro CDATA and replaces the broken Cloud macros.
 *
 * Usage:
 *   node sync_html_macros.js [options]
 *
 * Options:
 *   --dry-run                    Preview what would be updated without making changes
 *   --space <KEY>                Filter to specific space(s) (repeatable or comma-separated)
 *   --limit <n>                  Limit total pages to process
 *   --plan-only                  Build the plan and save it, but don't execute
 *   --execute-only               Load existing plan and execute without rebuilding
 *   --resume                     Alias for --execute-only
 *   --plan-file <path>           Path to plan JSON file to load
 *   --concurrency <n>            Max parallel Cloud PUT requests (default: 3)
 *   --retry-failed               Also reprocess pages with status "failed"
 *   --replacement-mode <mode>    "raw" (inline HTML, default), "macro" (preserve wrapper), or "code" (wrap in code block)
 *   --macro-type <types>         Comma-separated macro types to process: "html", "css", or "html,css" (default: html,css)
 *   --space-type <kind>          When --space is NOT used, restrict DC space enumeration to:
 *                                  "sites"    → site/global spaces only (default; matches Cloud)
 *                                  "personal" → personal spaces only (DC ~user spaces)
 *                                  "all"      → both
 *   --help                       Show this help message
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");
const HtmlMacroProcessor = require("../src/htmlMacroProcessor");

class HtmlMacroSync {
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
      replacementMode: options.replacementMode || "code",
      macroTypes: options.macroTypes || ["html", "css"],
      // Space-type filter when --space is NOT used (i.e. enumerating all DC spaces).
      // "sites"    → only global/site spaces (DC type=global). Default — Cloud has no personal spaces.
      // "personal" → only personal spaces (DC type=personal, keys prefixed "~").
      // "all"      → both site and personal spaces.
      spaceType: options.spaceType || "sites",
    };

    this.validateConfig();

    // Initialize logging
    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync HTML Macros Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    // Initialize clients
    this.dcClient = new DatacenterConfluenceClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
    );

    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, this.log);

    if (this.options.planFile) {
      this.planManager.setPlanFile(this.options.planFile);
    }

    this.startTime = Date.now();
  }

  validateConfig() {
    const required = [
      "DC_BASE_URL",
      "DC_USERNAME",
      "DC_PASSWORD",
      "CLOUD_BASE_URL",
      "CLOUD_EMAIL",
      "CLOUD_API_TOKEN",
    ];

    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCopy .env.example to .env and fill in the values.`,
      );
    }
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, line + "\n");
    } catch {
      // Ignore log write failures
    }
  }

  async run() {
    this.log("==============================================");
    this.log("Sync HTML/CSS Macros: Confluence DC -> Cloud");
    this.log("==============================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");

    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No changes will be made ***");
      this.log("");
    }

    if (this.options.limit > 0) {
      this.log(`  Page limit: ${this.options.limit}`);
    }
    if (this.options.spaceKeys.length > 0) {
      this.log(`  Spaces: ${this.options.spaceKeys.join(", ")}`);
    } else {
      this.log(`  Space type: ${this.options.spaceType} (no --space; enumerating all DC spaces matching this type)`);
    }
    if (this.options.planOnly) {
      this.log(`  Mode: PLAN ONLY (no execution)`);
    } else if (this.options.executeOnly) {
      this.log(`  Mode: EXECUTE ONLY (loading existing plan)`);
    } else {
      this.log(`  Mode: FULL (plan + execute)`);
    }
    this.log(`  Concurrency: ${this.options.concurrency}`);
    this.log(`  Macro types: ${this.options.macroTypes.join(", ")}`);
    this.log(`  Replacement mode: ${this.options.replacementMode}`);
    if (this.options.retryFailed) {
      this.log(`  Retry failed: YES (will reprocess failed pages)`);
    }

    // Step 1: Test connections
    this.log("\nStep 1: Testing connections...");

    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) {
      throw new Error("Cannot connect to Confluence Datacenter");
    }
    this.log("  Datacenter: OK");

    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) {
      throw new Error("Cannot connect to Confluence Cloud");
    }
    this.log("  Cloud: OK");

    // Create processor
    const processor = new HtmlMacroProcessor(
      this.dcClient,
      this.cloudClient,
      this.planManager,
      {
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        spaceKeys: this.options.spaceKeys,
        retryFailed: this.options.retryFailed,
        replacementMode: this.options.replacementMode,
        macroTypes: this.options.macroTypes,
        spaceType: this.options.spaceType,
        log: this.log,
      },
    );

    // ── Phase 1: Build or Load Plan ──
    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      const plan = this.planManager.loadPlan(this.options.planFile);
      if (!plan) {
        throw new Error(
          "No plan found. Run without --execute-only first to build a plan.",
        );
      }
    } else {
      const runId = String(Date.now());

      this.log("\nStep 2: Scanning DC for macros and building plan...");
      await processor.buildPlan(runId);

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY MODE - Skipping execution ***");
        this.printFinalReport(processor.getStats());
        return;
      }
    }

    // ── Phase 2: Execute Plan ──
    this.log(`\nStep ${this.options.executeOnly ? "3" : "3"}: Executing plan (${this.planManager.plan.stats.pending} pending pages)...`);
    await processor.executePlan();

    this.planManager.savePlan();
    this.printFinalReport(processor.getStats());
  }

  printFinalReport(processorStats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const dcStats = this.dcClient.getStats();
    const cloudStats = this.cloudClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) {
      this.log("*** DRY RUN - No actual changes were made ***\n");
    }

    this.log("Page Processing:");
    this.log(`  Spaces scanned:          ${processorStats.spacesScanned}`);
    this.log(`  Pages scanned (DC):      ${processorStats.pagesScanned}`);
    this.log(`  Pages with macros:       ${processorStats.pagesWithMacros}`);
    this.log(`  Matched in Cloud:        ${processorStats.pagesMatchedInCloud}`);
    this.log(`  Not found in Cloud:      ${processorStats.pagesNotFoundInCloud}`);
    this.log(`  Already in sync:         ${processorStats.pagesAlreadyInSync}`);
    this.log(`  Pages updated:           ${processorStats.pagesUpdated}`);
    this.log(`  Pages failed:            ${processorStats.pagesFailed}`);
    this.log(`  Pages skipped:           ${processorStats.pagesSkipped}`);

    const successRate =
      processorStats.pagesUpdated + processorStats.pagesFailed > 0
        ? ((processorStats.pagesUpdated / (processorStats.pagesUpdated + processorStats.pagesFailed)) * 100).toFixed(1)
        : "N/A";
    this.log(`  Success rate:            ${successRate}%`);

    if (planSummary) {
      this.log("\nPlan Status:");
      this.log(`  Total:      ${planSummary.total}`);
      this.log(`  Completed:  ${planSummary.completed}`);
      this.log(`  Failed:     ${planSummary.failed}`);
      this.log(`  Pending:    ${planSummary.pending}`);
      this.log(`  Skipped:    ${planSummary.skipped}`);
      this.log(`  Plan file:  ${planSummary.planFile || "N/A"}`);
    }

    this.log("\nAPI Statistics:");
    this.log(`  DC requests:     ${dcStats.requestCount} (${dcStats.errorCount} errors)`);
    this.log(`  Cloud requests:  ${cloudStats.requestCount} (${cloudStats.errorCount} errors, ${cloudStats.rateLimitCount} rate limits)`);

    this.log(`\nTotal elapsed time:  ${elapsed}s`);
    this.log(`Log file:            ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Sync HTML/CSS Macros: Confluence Datacenter -> Cloud

Two-phase architecture:
  Phase 1 (Plan):   Scan DC pages for HTML/CSS macros, extract content, match Cloud pages
  Phase 2 (Execute): Replace broken macro blocks in Cloud with DC content

When pages are migrated from DC to Cloud, HTML and CSS macros often break because
the macro apps are unavailable or behave differently. This script extracts the raw
content from DC page storage format and replaces the broken macros in Cloud.

Replacement Modes:
  "raw"   - Replace the entire macro block with inline content (default).
            Use when the macro app is NOT installed in Cloud.
  "macro" - Preserve the ac:structured-macro wrapper but fix the CDATA content.
            Use when the macro app IS installed in Cloud but content is wrong.
  "code"  - Wrap DC content in a Code macro block (preserves HTML/CSS via CDATA).
            Use when raw HTML gets stripped by Cloud's storage sanitizer.

Usage:
  node sync_html_macros.js [options]

Options:
  --dry-run                    Preview what would be updated without making changes
  --space <KEY>                Filter to specific space(s) (repeatable or comma-separated)
  --limit <n>                  Limit total pages to process
  --plan-only                  Build the plan and save it, but don't execute
  --execute-only               Load existing plan and execute without rebuilding
  --resume                     Alias for --execute-only (resume from last plan)
  --plan-file <path>           Path to plan JSON file to load
  --concurrency <n>            Max parallel Cloud PUT requests (default: 3)
  --retry-failed               Also reprocess pages with status "failed" (default: pending only)
  --replacement-mode <mode>    "raw", "macro", or "code" (default: raw)
  --macro-type <types>         Comma-separated macro types: "html", "css", "html,css" (default: html,css)
  --space-type <kind>          When --space is NOT used, restrict DC space enumeration:
                                 "sites"    → site/global spaces only (default; Cloud has no personal spaces)
                                 "personal" → personal spaces only (DC ~user spaces)
                                 "all"      → both
                               Ignored when --space is provided (explicit keys take priority).
  --help                       Show this help message

Environment Variables (in .env):
  DC_BASE_URL         Confluence Datacenter base URL
  DC_USERNAME         Datacenter username (Basic Auth)
  DC_PASSWORD         Datacenter password (Basic Auth)
  CLOUD_BASE_URL      Confluence Cloud base URL (e.g. https://site.atlassian.net/wiki)
  CLOUD_EMAIL         Cloud user email (Basic Auth)
  CLOUD_API_TOKEN     Cloud API token (Basic Auth)

Examples:
  # Build plan only for a specific space (preview)
  node sync_html_macros.js --plan-only --space PROJ

  # Build plan with a limit of 10 pages
  node sync_html_macros.js --plan-only --space PROJ --limit 10

  # Full sync in dry-run mode
  node sync_html_macros.js --dry-run --space PROJ

  # Execute existing plan with 5 concurrent requests
  node sync_html_macros.js --execute-only --concurrency 5

  # Resume from a specific plan file
  node sync_html_macros.js --resume --plan-file ./logs/plan_123456.json

  # Full sync with macro mode (HTML macro app installed in Cloud)
  node sync_html_macros.js --space PROJ --replacement-mode macro

  # Full sync — site spaces only (default, recommended for Cloud targets)
  node sync_html_macros.js

  # Full sync — personal spaces only (DC ~user spaces; usually not in Cloud)
  node sync_html_macros.js --space-type personal

  # Full sync — every DC space (sites + personal)
  node sync_html_macros.js --space-type all
    `);
  }
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = { spaceKeys: [] };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        HtmlMacroSync.showHelp();
        process.exit(0);
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--space": {
        const val = args[++i];
        if (val) {
          // Support comma-separated: --space PROJ1,PROJ2
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
      case "--replacement-mode": {
        const mode = args[++i];
        if (mode === "raw" || mode === "macro" || mode === "code") {
          options.replacementMode = mode;
        } else {
          console.warn(`Unknown replacement mode: ${mode}. Valid: raw, macro, code. Using default "raw".`);
        }
        break;
      }
      case "--macro-type": {
        const types = args[++i];
        if (types) {
          const valid = ["html", "css"];
          const parsed = types.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
          const invalid = parsed.filter((t) => !valid.includes(t));
          if (invalid.length > 0) {
            console.warn(`Unknown macro type(s): ${invalid.join(", ")}. Valid: ${valid.join(", ")}`);
          }
          const validTypes = parsed.filter((t) => valid.includes(t));
          if (validTypes.length > 0) {
            options.macroTypes = validTypes;
          }
        }
        break;
      }
      case "--space-type": {
        const t = (args[++i] || "").trim().toLowerCase();
        const valid = ["sites", "personal", "all"];
        if (valid.includes(t)) {
          options.spaceType = t;
        } else {
          console.warn(`Unknown --space-type "${t}". Valid: ${valid.join(", ")}. Using default "sites".`);
        }
        break;
      }
      default:
        if (args[i].startsWith("--")) {
          console.warn(`Unknown option: ${args[i]}`);
        }
        break;
    }
  }

  return options;
}

// Main execution
async function main() {
  let sync = null;

  const shutdown = () => {
    if (sync && sync.planManager) {
      console.log("\nShutting down gracefully...");
      if (sync.planManager.plan) {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    sync = new HtmlMacroSync(options);
    await sync.run();
    console.log("\nSync completed successfully.");
    process.exit(0);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    if (sync && sync.planManager) {
      if (sync.planManager.plan) {
        sync.planManager.savePlan();
        console.log(`Plan saved: ${sync.planManager.planFilePath}`);
      }
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = HtmlMacroSync;
