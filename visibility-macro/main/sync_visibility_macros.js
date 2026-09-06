#!/usr/bin/env node

/**
 * Sync Visibility Macros: translate DC user/group names → Cloud accountId/groupId
 * for the Visibility for Confluence "Show If" / "Hide If" macros.
 *
 * Discovery is Cloud-driven (CQL on Cloud), DC is consulted as ground-truth source
 * for the original user/group names because the Cloud macro often has them blanked
 * post-migration.
 *
 * Usage:
 *   node sync_visibility_macros.js [options]
 *
 * Options:
 *   --dry-run                       Preview, no writes
 *   --space <KEY>                   Filter (repeatable / comma-separated). Required unless --all
 *   --all                           Scan every space (use with care)
 *   --limit <n>                     Max pages to plan
 *   --plan-only                     Build plan, don't execute
 *   --execute-only / --resume       Load plan and execute
 *   --plan-file <path>              Path to plan JSON file
 *   --concurrency <n>               Default 3
 *   --retry-failed                  Reprocess failed pages
 *   --macro-name <list>             Default "show-if,hide-if"
 *   --cloud-groups-param-name <n>   Default "groups" (Cloud); some tenants use "user-groups"
 *   --user-mapping <csv>            DC username,accountId
 *   --group-mapping <csv>           DC groupName,groupId
 *   --help                          Show this help message
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");
const IdentityResolver = require("../src/identityResolver");
const VisibilityMacroProcessor = require("../src/visibilityMacroProcessor");

class VisibilityMacroSync {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      spaceKeys: options.spaceKeys || [],
      scanAllSpaces: options.scanAllSpaces || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 3,
      retryFailed: options.retryFailed || false,
      macroNames: options.macroNames || ["show-if", "hide-if"],
      cloudGroupsParamName: options.cloudGroupsParamName || "groups",
      userMappingPath: options.userMappingPath || null,
      groupMappingPath: options.groupMappingPath || null,
      templatePageId: options.templatePageId || null,
      defaultGroupsFallback: options.defaultGroupsFallback || null,
      strictDc: options.strictDc || false,
    };

    this.validateConfig();

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `sync_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Sync Visibility Macros Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );
    this.log = this.log.bind(this);

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
    this.planManager = new PlanManager(this.logDir, this.log);
    if (this.options.planFile) this.planManager.setPlanFile(this.options.planFile);

    this.resolver = new IdentityResolver(this.cloudClient, {
      cacheDir: this.logDir,
      log: this.log,
      userMappingPath: this.options.userMappingPath,
      groupMappingPath: this.options.groupMappingPath,
    });

    this.startTime = Date.now();
  }

  validateConfig() {
    const required = [
      "DC_BASE_URL",
      "CLOUD_BASE_URL",
      "CLOUD_EMAIL",
      "CLOUD_API_TOKEN",
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (!process.env.DC_PAT && (!process.env.DC_USERNAME || !process.env.DC_PASSWORD)) {
      missing.push("DC_PAT (or DC_USERNAME + DC_PASSWORD)");
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCopy .env.example to .env and fill in the values.`,
      );
    }
    if (
      !this.options.executeOnly &&
      this.options.spaceKeys.length === 0 &&
      !this.options.scanAllSpaces
    ) {
      throw new Error(
        "No spaces specified. Pass --space KEY (repeatable) or --all to scan everything.",
      );
    }
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, line + "\n");
    } catch {
      // ignore
    }
  }

  /**
   * Fetch a page known to contain at least one Forge ecosystem show-if
   * macro and persist its tenant template (extensionKey, extensionId,
   * embeddedMacroContext, etc.) to logs/forge_template.json.
   */
  async _seedForgeTemplate(pageId) {
    const templatePath = path.join(this.logDir, "forge_template.json");
    if (fs.existsSync(templatePath)) {
      this.log(`  Template already cached at ${templatePath}, leaving as-is`);
      return;
    }
    const page = await this.cloudClient.getPageAdf(pageId);
    const adf = JSON.parse(page.body?.atlas_doc_format?.value || "{}");
    let template = null;
    const walk = (node) => {
      if (!node || typeof node !== "object" || template) return;
      if (node.type === "bodiedExtension" && node.attrs) {
        const ek = node.attrs.extensionKey || "";
        const et = node.attrs.extensionType || "";
        const isShowIf = ek === "show-if" || ek.endsWith("/show-if");
        if (isShowIf && et === "com.atlassian.ecosystem") {
          const a = node.attrs;
          const p = a.parameters || {};
          template = {
            extensionKey: a.extensionKey,
            extensionType: a.extensionType,
            text: a.text || "Visibility - Show if",
            extensionTitle: a.extensionTitle || "Visibility - Show if",
            extensionId: p.extensionId,
            forgeEnvironment: p.forgeEnvironment || "PRODUCTION",
            embeddedMacroContext: p.embeddedMacroContext,
          };
        }
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(adf);
    if (!template) {
      throw new Error(
        `No Forge ecosystem show-if macro found on page ${pageId}. Pick a different --template-page that has at least one already-converted Show If macro.`,
      );
    }
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
    this.log(`  Forge template saved: extensionKey=${template.extensionKey}`);
  }

  async run() {
    this.log("==================================================");
    this.log("Sync Visibility Macros: DC names -> Cloud IDs");
    this.log("==================================================");
    this.log(`  DC:    ${process.env.DC_BASE_URL}`);
    this.log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
    this.log("");
    if (this.options.dryRun) {
      this.log("*** DRY RUN MODE - No changes will be made ***\n");
    }
    if (this.options.limit > 0) this.log(`  Page limit: ${this.options.limit}`);
    if (this.options.spaceKeys.length > 0) {
      this.log(`  Spaces: ${this.options.spaceKeys.join(", ")}`);
    }
    if (this.options.scanAllSpaces) this.log(`  Scope: ALL spaces`);
    if (this.options.planOnly) this.log(`  Mode: PLAN ONLY (no execution)`);
    else if (this.options.executeOnly) this.log(`  Mode: EXECUTE ONLY (load existing plan)`);
    else this.log(`  Mode: FULL (plan + execute)`);
    this.log(`  Concurrency: ${this.options.concurrency}`);
    this.log(`  Macro names: ${this.options.macroNames.join(", ")}`);
    this.log(`  Cloud groups param name (write): ${this.options.cloudGroupsParamName}`);
    if (this.options.userMappingPath) this.log(`  User mapping CSV: ${this.options.userMappingPath}`);
    if (this.options.groupMappingPath) this.log(`  Group mapping CSV: ${this.options.groupMappingPath}`);
    if (this.options.retryFailed) this.log(`  Retry failed: YES`);
    if (this.options.defaultGroupsFallback) {
      this.log(
        `  Default groups fallback: names="${this.options.defaultGroupsFallback.names}" ids="${this.options.defaultGroupsFallback.ids}"`,
      );
    }
    if (this.options.strictDc) {
      this.log(`  Strict DC mode: ON (Cloud will be forced to DC's state when DC macro is matched)`);
      if (this.options.defaultGroupsFallback) {
        this.log(`  NOTE: --strict-dc overrides --default-groups fallback (fallback disabled).`);
      }
    }

    this.log("\nStep 1: Testing connections...");
    const dcOk = await this.dcClient.testConnection();
    if (!dcOk) throw new Error("Cannot connect to Confluence Datacenter");
    this.log("  Datacenter: OK");
    const cloudOk = await this.cloudClient.testConnection();
    if (!cloudOk) throw new Error("Cannot connect to Confluence Cloud");
    this.log("  Cloud: OK");

    // Seed Forge template up-front from a known-good page, if requested
    // and not already cached.
    if (this.options.templatePageId) {
      this.log(`\nStep 1b: Seeding Forge template from page ${this.options.templatePageId}...`);
      await this._seedForgeTemplate(this.options.templatePageId);
    }

    const processor = new VisibilityMacroProcessor(
      this.dcClient,
      this.cloudClient,
      this.planManager,
      this.resolver,
      {
        dryRun: this.options.dryRun,
        limit: this.options.limit,
        concurrency: this.options.concurrency,
        spaceKeys: this.options.spaceKeys,
        scanAllSpaces: this.options.scanAllSpaces,
        retryFailed: this.options.retryFailed,
        macroNames: this.options.macroNames,
        cacheDir: this.logDir,
        log: this.log,
        defaultGroupsFallback: this.options.defaultGroupsFallback,
        strictDc: this.options.strictDc,
      },
    );

    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      const plan = this.planManager.loadPlan(this.options.planFile);
      if (!plan) throw new Error("No plan found. Run without --execute-only first.");
    } else {
      const runId = String(Date.now());
      this.log("\nStep 2: Scanning Cloud for visibility macros and building plan...");
      await processor.buildPlan(runId);

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY MODE - Skipping execution ***");
        this.printFinalReport(processor.getStats());
        return;
      }
    }

    this.log(`\nStep 3: Executing plan (${this.planManager.plan.stats.pending} pending pages)...`);
    await processor.executePlan();
    this.planManager.savePlan();
    this.printFinalReport(processor.getStats());
  }

  printFinalReport(processorStats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const dcStats = this.dcClient.getStats();
    const cloudStats = this.cloudClient.getStats();
    const planSummary = this.planManager.getPlanSummary();
    const resolverStats = this.resolver.getStats();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));
    if (this.options.dryRun) this.log("*** DRY RUN - No actual changes were made ***\n");

    this.log("Page Processing:");
    this.log(`  Spaces scanned:          ${processorStats.spacesScanned}`);
    this.log(`  Cloud pages found:       ${processorStats.cloudPagesFound}`);
    this.log(`  With visibility macros:  ${processorStats.pagesWithMacros}`);
    this.log(`  Matched in DC:           ${processorStats.pagesMatchedInDc}`);
    this.log(`  Not found in DC:         ${processorStats.pagesNotFoundInDc}`);
    this.log(`  Pages updated:           ${processorStats.pagesUpdated}`);
    this.log(`  Pages failed:            ${processorStats.pagesFailed}`);
    this.log(`  Pages skipped:           ${processorStats.pagesSkipped}`);
    this.log(`  Pages with unresolved:   ${processorStats.pagesUnresolved}`);

    this.log("\nMacro Resolution:");
    this.log(`  Macros total:            ${processorStats.macrosTotal}`);
    this.log(`  Macros resolved (any):   ${processorStats.macrosResolved}`);
    this.log(`  Macros with unresolved:  ${processorStats.macrosUnresolved}`);
    this.log(`  Macros defaulted to fallback: ${processorStats.macrosDefaultedToFallback || 0}`);
    this.log(`  Macros skipped (scaffolding): ${processorStats.macrosSkippedScaffolding || 0}`);

    this.log("\nIdentity Lookups:");
    this.log(`  API lookups:             ${resolverStats.apiLookups}`);
    this.log(`  Group hits / misses:     ${resolverStats.groupHits} / ${resolverStats.groupMisses}`);
    this.log(`  User hits / misses:      ${resolverStats.userHits} / ${resolverStats.userMisses}`);

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
Sync Visibility Macros: translate DC user/group names -> Cloud IDs

After migration, the Visibility for Confluence (Show If / Hide If) macros stop
working because their 'users' and 'user-groups' parameters reference DC
usernames / DC group names. Cloud expects 'accountId' and 'groupId'. This
script scans Cloud for affected pages, looks up the DC source for ground truth,
and rewrites the macro params.

Usage:
  node sync_visibility_macros.js [options]

Options:
  --dry-run                       Preview, no writes
  --space <KEY>                   Filter (repeatable / comma-separated). Required unless --all
  --all                           Scan every space (use with care)
  --limit <n>                     Max pages to plan
  --plan-only                     Build plan, don't execute
  --execute-only                  Load plan and execute
  --resume                        Alias for --execute-only
  --plan-file <path>              Path to plan JSON file
  --concurrency <n>               Default 3
  --retry-failed                  Reprocess failed pages
  --macro-name <list>             Default "show-if,hide-if"
  --cloud-groups-param-name <n>   Default "groups" (Cloud); some tenants use "user-groups"
  --user-mapping <csv>            DC username,accountId  (overrides API lookup for users)
  --group-mapping <csv>           DC groupName,groupId   (overrides API lookup for groups)
  --template-page <pageId>        Cloud page ID containing >=1 already-converted Forge show-if
                                  macro. Seeded once into logs/forge_template.json and reused.
  --default-groups <list>         Fallback groups (name:id pairs, comma-separated) to apply
                                  when a macro plans out with NO group AND NO user. e.g.
                                  --default-groups "staff:d2c24fb4-...,wiki_external:60b6bd24-..."
  --strict-dc                     Force Cloud to mirror DC exactly when the DC page+macro is
                                  matched. Empty groups/users in DC will CLEAR them in Cloud
                                  (useful to revert a prior --default-groups run). Pages where
                                  the DC page or macro could not be matched are still left alone.
                                  Overrides / disables --default-groups when both are set.
  --help                          Show this help message

Environment Variables (in .env):
  DC_BASE_URL, DC_USERNAME, DC_PASSWORD
  CLOUD_BASE_URL, CLOUD_EMAIL, CLOUD_API_TOKEN

Examples:
  # Single page sandbox test (the DOCS example), dry-run
  node sync_visibility_macros.js --dry-run --space DOCS --limit 1

  # Plan only, single space
  node sync_visibility_macros.js --plan-only --space DOCS

  # Real execute of an existing plan
  node sync_visibility_macros.js --execute-only --plan-file logs/plan_<id>.json

  # Full run across multiple spaces
  node sync_visibility_macros.js --space DOCS,OPS,DOCS --concurrency 5
    `);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { spaceKeys: [] };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        VisibilityMacroSync.showHelp();
        process.exit(0);
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--space": {
        const v = args[++i];
        if (v) {
          const keys = v.split(",").map((k) => k.trim()).filter(Boolean);
          options.spaceKeys.push(...keys);
        }
        break;
      }
      case "--all":
        options.scanAllSpaces = true;
        break;
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
      case "--macro-name": {
        const v = args[++i];
        if (v) {
          options.macroNames = v.split(",").map((s) => s.trim()).filter(Boolean);
        }
        break;
      }
      case "--cloud-groups-param-name":
        options.cloudGroupsParamName = args[++i];
        break;
      case "--user-mapping":
        options.userMappingPath = args[++i];
        break;
      case "--group-mapping":
        options.groupMappingPath = args[++i];
        break;
      case "--template-page":
        options.templatePageId = args[++i];
        break;
      case "--strict-dc":
        options.strictDc = true;
        break;
      case "--default-groups": {
        // Format: "name1:id1,name2:id2"  (names optional, id required)
        const v = args[++i];
        if (v) {
          const pairs = v.split(",").map((s) => s.trim()).filter(Boolean);
          const names = [];
          const ids = [];
          for (const p of pairs) {
            const colon = p.indexOf(":");
            if (colon === -1) {
              ids.push(p);
              names.push("");
            } else {
              names.push(p.substring(0, colon).trim());
              ids.push(p.substring(colon + 1).trim());
            }
          }
          options.defaultGroupsFallback = {
            names: names.join(","),
            ids: ids.join(","),
          };
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
    sync = new VisibilityMacroSync(options);
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

if (require.main === module) {
  main();
}

module.exports = VisibilityMacroSync;
