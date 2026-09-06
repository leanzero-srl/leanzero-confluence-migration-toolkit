#!/usr/bin/env node

/**
 * sync_responsibility_to_aura.js
 *
 * Cloud-only migration: convert leftover Linchpin "Content Responsibility"
 * macros (Server/DC-only, render as "Unknown macro" in Cloud) to
 * "Aura User Profile" macros (Forge Cloud app by Aura Apps / Seibert).
 *
 * Pipeline:
 *   1. CQL-scan Cloud for pages whose storage still carries the Linchpin
 *      macro `ac:name="<source>"`.
 *   2. For each candidate, GET the storage XHTML, extract user tokens
 *      from the macro's users parameter.
 *   3. Resolve each unique token to a Cloud accountId via the Jira
 *      user-search endpoint (cached on disk).
 *   4. Splice the Responsibility macro span with one (or more) Aura
 *      User Profile macros (chunked at 10 users per macro — Aura's
 *      documented limit), each carrying the resolved accountIds.
 *   5. PUT the new storage back at version+1. Save a per-page backup
 *      (.xhtml, .diff.patch, .meta.json) before each PUT.
 *
 * USAGE
 *
 *   # Discovery: dump raw storage XML for the first N matching pages so
 *   # you can confirm the exact ac:name and parameter shape before any
 *   # rewrites. Recommended first run on a new tenant.
 *   node main/sync_responsibility_to_aura.js --discovery-dump --space TEST --limit 5
 *
 *   # Standard dry-run on one page
 *   node main/sync_responsibility_to_aura.js --dry-run --space TEST --limit 1
 *
 *   # Build a plan, inspect, then apply
 *   node main/sync_responsibility_to_aura.js --plan-only --space TEST
 *   node main/sync_responsibility_to_aura.js --execute-only --plan-file logs/plan_<id>.json
 *
 *   # Full tenant run
 *   node main/sync_responsibility_to_aura.js --all --concurrency 5
 *
 * Required env (.env at script root):
 *   CLOUD_BASE_URL=https://<tenant>.atlassian.net/wiki
 *   CLOUD_EMAIL=<email>
 *   CLOUD_API_TOKEN=<api-token>     # same token works for Confluence v1
 *                                   # and Jira v3 user-search on the
 *                                   # same atlassian.net tenant
 *
 * See `--help` for the full flag list.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const PlanManager = require("../src/planManager");
const ResponsibilityMacroProcessor = require("../src/responsibilityMacroProcessor");
const IdentityResolver = require("../src/identityResolver");

// ─────────────────────────────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    planOnly: false,
    executeOnly: false,
    planFile: null,
    dryRun: false,
    discoveryDump: false,
    spaceKeys: [],
    scanAllSpaces: false,
    cloudPageIds: [],
    limit: 0,
    concurrency: 3,
    retryFailed: false,
    sourceMacroNames: [],
    sourceUsersParam: null,
    targetApp: "aura",
    targetMacroName: null,
    targetUsersParam: null,
    targetUsersUseRiUser: false,
    auraOutputMode: "rich",
    maxUsersPerAura: 10,
    userMappingPath: null,
    pageUsersCsv: null,
    defaultInfoLabel: null,
    versionMessage: "Responsibility -> Aura User Profile (auto-migrated)",
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
      case "--discovery-dump": o.discoveryDump = true; break;
      case "--space": {
        const v = argv[++i];
        if (v) o.spaceKeys.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--all": o.scanAllSpaces = true; break;
      case "--cloud-page-id": {
        const v = argv[++i];
        if (v) o.cloudPageIds.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--limit": o.limit = parseInt(argv[++i], 10) || 0; break;
      case "--concurrency": o.concurrency = parseInt(argv[++i], 10) || 3; break;
      case "--retry-failed": o.retryFailed = true; break;
      case "--source-macro-name": o.sourceMacroNames.push(argv[++i]); break;
      case "--source-users-param": o.sourceUsersParam = argv[++i]; break;
      case "--target-app": {
        const v = String(argv[++i] || "").toLowerCase();
        o.targetApp = ["userprofile", "contactperson"].includes(v) ? v : "aura";
        break;
      }
      case "--target-macro-name": o.targetMacroName = argv[++i]; break;
      case "--target-users-param": o.targetUsersParam = argv[++i]; break;
      case "--target-users-ri-user": o.targetUsersUseRiUser = true; break;
      case "--aura-output-mode": o.auraOutputMode = argv[++i]; break;
      case "--max-users-per-aura": o.maxUsersPerAura = parseInt(argv[++i], 10) || 10; break;
      case "--user-mapping": o.userMappingPath = argv[++i]; break;
      case "--page-users-csv": o.pageUsersCsv = argv[++i]; break;
      case "--default-info-label": o.defaultInfoLabel = argv[++i]; break;
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
Usage: node main/sync_responsibility_to_aura.js [options]

Phases:
  default                     plan + execute in one run
  --plan-only                 build plan, skip execute
  --execute-only [--plan-file <path>]   load plan and execute
  --dry-run                   simulate execute (no PUTs); still writes backups
  --discovery-dump            CQL-search, dump raw storage XML of the first --limit
                              pages, then exit. Use to confirm ac:name and
                              parameter shape on a new tenant.

Scope:
  --space K[,K...]            limit to one or more space keys
  --all                       scan every space (one of --space or --all required)
  --limit N                   cap the number of planned pages
  --concurrency N             worker pool size (default 3)
  --retry-failed              re-attempt pages with status="failed"

Source-macro tuning (defaults locked to confirmed Linchpin shape):
  --source-macro-name NAME    repeatable; default ["responsible-person-macro"]
  --source-users-param NAME   parameter holding users IF the macro has them inline
                              (Linchpin's doesn't — provide users via --page-users-csv)
  --user-mapping FILE         CSV (token,accountId) override for Jira resolver

DC-extracted users (REQUIRED for real runs, since the source macro is empty):
  --page-users-csv FILE       CSV with pageId,token[,token...] one row per page;
                              tokens can be Cloud accountIds OR DC userkeys/usernames
                              (the latter are resolved via Jira user-search).
                              Produced by dc/extract_dc.js after dc/probe_dc.js
                              identifies the working extraction strategy.

Target app (which Cloud macro replaces the Linchpin macro):
  --target-app APP            "aura" (default) — Aura User Profile (Forge app),
                              multi-user cards, resolved by accountId.
                              "userprofile"    — NATIVE Confluence User Profile
                              macro (ac:name="profile"). No app/license needed,
                              ONE user per macro, resolved by accountId.
                              "contactperson"  — Forge Primary Contact Macro
                              (adf-extension) keyed by EntraID object id. ONE
                              person per macro, rich card. --page-users-csv
                              tokens must be EntraID object ids (ms-account-id),
                              NOT accountIds — no Jira resolution is performed.

Target-macro tuning (Aura only; defaults match the user's working sample):
  --target-macro-name NAME    Aura ac:name (default "aura-user-profile")
  --aura-output-mode MODE     "rich" (default, real Aura wire format) | "simple" (test only)
  --default-info-label TEXT   per-card "info" label fallback (default "Role Title")
  --target-users-param NAME   simple-mode only: parameter on Aura macro (default "users")
  --target-users-ri-user      simple-mode only: emit <ri:user .../> instead of CSV
  --max-users-per-aura N      simple-mode only: chunk size (default 10, irrelevant in rich)

Output:
  --backup-dir PATH           override default ./backups/
  --no-backup                 don't write per-page backups (NOT RECOMMENDED)
  --no-verify-after           skip the post-run residual-CQL check
  --version-message MSG       PUT version comment
`);
}

// ─────────────────────────────────────────────────────────────────────
//  ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────

class ResponsibilityToAuraSync {
  constructor(opts) {
    this.opts = opts;

    if (!process.env.CLOUD_BASE_URL || !process.env.CLOUD_EMAIL || !process.env.CLOUD_API_TOKEN) {
      throw new Error(
        "Missing CLOUD_BASE_URL, CLOUD_EMAIL or CLOUD_API_TOKEN in .env (resolved relative to confluence/responsibility-to-aura/)",
      );
    }

    this.scriptRoot = path.resolve(__dirname, "..");
    this.logDir = path.join(this.scriptRoot, "logs");
    this.backupDir = path.resolve(opts.backupDir || path.join(this.scriptRoot, "backups"));
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    if (!opts.noBackup && !fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const ts = Date.now();
    this.runId = String(ts);
    this.logFile = path.join(this.logDir, `sync_${ts}.log`);
    fs.writeFileSync(
      this.logFile,
      `Responsibility -> Aura Sync Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.lossyCsvPath = path.join(this.logDir, `lossy_params_${ts}.csv`);
    this.unresolvedCsvPath = path.join(this.logDir, `unresolved_users_${ts}.csv`);
    this._appendCsv(this.lossyCsvPath, "pageId,spaceKey,macroId,paramName,droppedValue\n");
    this._appendCsv(this.unresolvedCsvPath, "pageId,spaceKey,macroId,sourceToken\n");

    this.cloudClient = new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_EMAIL,
      process.env.CLOUD_API_TOKEN,
    );

    this.planManager = new PlanManager(this.logDir, (m) => this.log(m));

    const processorOpts = {
      log: (m) => this.log(m),
      maxUsersPerAura: opts.maxUsersPerAura,
      auraOutputMode: opts.auraOutputMode,
      targetApp: opts.targetApp,
    };
    if (opts.sourceMacroNames.length) processorOpts.sourceMacroNames = opts.sourceMacroNames;
    if (opts.sourceUsersParam) processorOpts.sourceUsersParam = opts.sourceUsersParam;
    if (opts.targetMacroName) processorOpts.targetMacroName = opts.targetMacroName;
    if (opts.targetUsersParam) processorOpts.targetUsersParam = opts.targetUsersParam;
    if (opts.targetUsersUseRiUser) processorOpts.targetUsersUseRiUser = true;
    if (opts.defaultInfoLabel) processorOpts.defaultInfoLabel = opts.defaultInfoLabel;
    this.processor = new ResponsibilityMacroProcessor(processorOpts);

    // Load DC-extracted CSV. Index modes (all populated in parallel):
    //   - macroId-keyed (preferred IF CCMA preserved macroIds — usually NOT)
    //   - title+space-keyed (the robust matcher; survives CCMA pageId
    //     re-assignment because page titles and space keys carry through)
    //   - pageId-keyed (legacy; matches only if DC and Cloud use the same
    //     pageId, which is rare after migration)
    //
    // CSV schema (current):
    //   pageId,macroId,spaceKey,title,token,token,...
    // (Legacy schema with just `pageId,macroId,token,...` or `pageId,token,...`
    // is still accepted — title/space fields are simply absent.)
    this.macroTokensMap = new Map();      // macroId        -> string[]
    this.pageTokensMap = new Map();       // pageId         -> string[]
    this.titleSpaceTokensMap = new Map(); // `${space}:${title}` -> string[]
    if (opts.pageUsersCsv) this._loadPageUsersCsv(opts.pageUsersCsv);

    this.resolver = new IdentityResolver(this.cloudClient, {
      cacheDir: this.logDir,
      log: (m) => this.log(m),
      userMappingPath: opts.userMappingPath,
    });

    this.stats = {
      cloudPagesFound: 0,
      pagesPlanned: 0,
      pagesWithUnresolved: 0,
      pagesUpdated: 0,
      pagesSkipped: 0,
      pagesFailed: 0,
      macrosFound: 0,
      macrosRewritten: 0,
      uniqueTokens: 0,
      tokensResolved: 0,
      tokensUnresolved: 0,
    };
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try { fs.appendFileSync(this.logFile, line + "\n"); } catch (_) { /* swallow */ }
  }

  _appendCsv(filePath, line) {
    try { fs.appendFileSync(filePath, line); } catch (_) { /* swallow */ }
  }

  _loadPageUsersCsv(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`--page-users-csv file not found: ${filePath}`);
    }
    // Properly parse a CSV line that supports double-quoted fields with
    // embedded commas/quotes (titles can contain commas, ampersands, etc.).
    const splitCsv = (line) => {
      const out = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') { inQ = false; }
          else { cur += c; }
        } else if (c === '"') {
          inQ = true;
        } else if (c === ",") {
          out.push(cur); cur = "";
        } else {
          cur += c;
        }
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const macroIdRe = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    let rows = 0;
    let schema = null; // detected from header: "v2" (with space+title) or "v1" (without)

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = splitCsv(line);
      const head0 = (parts[0] || "").toLowerCase();
      // Detect schema from header row
      if (head0 === "pageid" || head0 === "page_id" || head0 === "page-id") {
        const headers = parts.map((s) => s.toLowerCase());
        schema = (headers.includes("title") || headers.includes("spacekey") || headers.includes("space_key"))
          ? "v2"
          : "v1";
        continue;
      }
      const pageId = parts[0];
      if (!pageId) continue;
      let macroId = null, spaceKey = "", title = "", tokens = [];
      // Auto-detect schema if no header
      if (parts.length >= 4 && macroIdRe.test(parts[1])) {
        // v2: pageId, macroId, spaceKey, title, tokens...
        macroId = parts[1];
        spaceKey = parts[2];
        title = parts[3];
        tokens = parts.slice(4).filter(Boolean);
      } else if (parts.length >= 2 && macroIdRe.test(parts[1])) {
        // v1 with macroId: pageId, macroId, tokens...
        macroId = parts[1];
        tokens = parts.slice(2).filter(Boolean);
      } else {
        // v1 page-level: pageId, tokens...
        tokens = parts.slice(1).filter(Boolean);
      }
      if (tokens.length === 0) continue;

      if (macroId) {
        const existing = this.macroTokensMap.get(macroId) || [];
        this.macroTokensMap.set(macroId, [...existing, ...tokens]);
      }
      if (title && spaceKey) {
        const k = `${spaceKey}:${title}`;
        const existing = this.titleSpaceTokensMap.get(k) || [];
        const merged = [...existing];
        for (const t of tokens) if (!merged.includes(t)) merged.push(t);
        this.titleSpaceTokensMap.set(k, merged);
      }
      // Union into pageTokensMap as the page-level fallback
      const pageExisting = this.pageTokensMap.get(pageId) || [];
      const merged = [...pageExisting];
      for (const t of tokens) if (!merged.includes(t)) merged.push(t);
      this.pageTokensMap.set(pageId, merged);
      rows++;
    }
    this.log(
      `  [CSV] Loaded ${rows} row(s) from ${filePath} (schema=${schema || "auto"}): ` +
      `macro-keyed=${this.macroTokensMap.size}, title+space-keyed=${this.titleSpaceTokensMap.size}, page-keyed=${this.pageTokensMap.size}`,
    );
  }

  _csvEsc(v) {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
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

  _buildSourceCql(spaceKey) {
    const namesQuoted = this.processor.sourceMacroNames
      .map((n) => `"${n}"`)
      .join(",");
    return spaceKey
      ? `space = "${spaceKey}" AND macro in (${namesQuoted}) AND type = page ORDER BY id`
      : `macro in (${namesQuoted}) AND type = page ORDER BY id`;
  }

  async _collectCandidates() {
    if (!this.opts.scanAllSpaces && this.opts.spaceKeys.length === 0 && this.opts.cloudPageIds.length === 0) {
      throw new Error("Specify --space KEY[,KEY,...] or --all or --cloud-page-id ID");
    }

    // Targeted-page mode: fetch each Cloud pageId directly, no CQL search.
    // Useful for one-page tests and surgical re-runs.
    if (this.opts.cloudPageIds.length > 0) {
      const out = [];
      for (const pid of this.opts.cloudPageIds) {
        try {
          const p = await this.cloudClient.getPageStorage(pid);
          this.stats.cloudPagesFound++;
          out.push(p);
          this.log(`  Targeted page ${pid}: "${p.title}" (space ${p.space?.key})`);
        } catch (e) {
          this.log(`  Targeted page ${pid}: fetch failed: ${e.message}`);
        }
      }
      return out;
    }
    const spaces = this.opts.spaceKeys.length > 0
      ? this.opts.spaceKeys.map((k) => ({ key: k }))
      : [{ key: null }];

    const candidates = [];
    let stop = false;
    for (const sp of spaces) {
      this.log(`\nScanning space: ${sp.key || "<all>"}`);
      const cql = this._buildSourceCql(sp.key);
      this.log(`  CQL: ${cql}`);
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
    return candidates;
  }

  // ─── DISCOVERY DUMP ────────────────────────────────────────────────

  async discoveryDump() {
    const candidates = await this._collectCandidates();
    if (candidates.length === 0) {
      this.log("\n  No candidate pages found. Try a broader --source-macro-name set, or check the tenant has Linchpin macros at all.");
      return;
    }
    const dumpDir = path.join(this.logDir, `discovery_${this.runId}`);
    fs.mkdirSync(dumpDir, { recursive: true });
    this.log(`\nDumping raw storage XML for ${candidates.length} page(s) to ${dumpDir}/`);

    let idx = 0;
    for (const cp of candidates) {
      idx++;
      const id = String(cp.id);
      try {
        const sp = await this.cloudClient.getPageStorage(id);
        const storage = sp.body?.storage?.value || "";
        const outFile = path.join(dumpDir, `page_${id}_v${sp.version?.number || 0}.xhtml`);
        fs.writeFileSync(outFile, storage, "utf8");
        const instances = this.processor.findCandidateMacros(storage);
        const namesSeen = instances.map((i) => i.name).join(", ") || "(none matched current source-macro-name list)";
        this.log(`  [${idx}/${candidates.length}] ${id} "${cp.title}" — ${instances.length} macro(s) matched: ${namesSeen}`);
        if (instances.length > 0) {
          const macroSummary = instances.map((inst) => ({
            macroId: inst.macroId,
            name: inst.name,
            schemaVersion: inst.schemaVersion,
            paramKeys: Object.keys(inst.params || {}),
            usersParamPreview: (inst.params || {})[this.processor.sourceUsersParam]?.substring(0, 500) || null,
            tokens: this.processor.extractUserTokens(inst),
          }));
          fs.writeFileSync(outFile.replace(/\.xhtml$/, ".macros.json"), JSON.stringify(macroSummary, null, 2), "utf8");
        }
      } catch (e) {
        this.log(`  [${idx}/${candidates.length}] ${id} ERROR: ${e.message}`);
      }
    }
    this.log(`\nDiscovery dump complete. Inspect ${dumpDir}/ and update --source-macro-name / --source-users-param / --target-macro-name / --target-users-param if needed.`);
  }

  // ─── PHASE 1: BUILD PLAN ───────────────────────────────────────────

  async buildPlan() {
    const candidates = await this._collectCandidates();
    this.planManager.createPlan(this.runId);

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
      if (instances.length === 0) return;

      this.stats.macrosFound += instances.length;
      // Token source precedence (per-macro):
      //   1. CSV row keyed by exact macroId (preferred when CCMA kept ids).
      //   2. CSV row keyed by Cloud (space, title) — the robust matcher,
      //      survives CCMA pageId/macroId re-assignment.
      //   3. CSV row keyed by raw pageId (works only if DC and Cloud
      //      happen to share pageIds — uncommon).
      //   4. Inline macro tokens (Linchpin's macro doesn't carry users,
      //      but other variants might).
      const titleSpaceKey = (spaceKey && title) ? `${spaceKey}:${title}` : null;
      const titleSpaceTokens = (titleSpaceKey && this.titleSpaceTokensMap.get(titleSpaceKey)) || null;
      const pageCsvTokens = this.pageTokensMap.get(id) || null;
      const macroPlans = instances.map((inst) => {
        const inlineTokens = this.processor.extractUserTokens(inst);
        const macroCsvTokens = (inst.macroId && this.macroTokensMap.get(inst.macroId)) || null;
        let tokens, tokenSource;
        if (macroCsvTokens && macroCsvTokens.length > 0) {
          tokens = macroCsvTokens;    tokenSource = "macro-csv";
        } else if (titleSpaceTokens && titleSpaceTokens.length > 0) {
          tokens = titleSpaceTokens;  tokenSource = "title+space-csv";
        } else if (pageCsvTokens && pageCsvTokens.length > 0) {
          tokens = pageCsvTokens;     tokenSource = "page-csv";
        } else if (inlineTokens.length > 0) {
          tokens = inlineTokens;      tokenSource = "macro-inline";
        } else {
          tokens = [];                tokenSource = "none";
        }
        const droppedParams = [];
        for (const lp of this.processor.lossyParams) {
          if (lp in (inst.params || {}) && inst.params[lp] !== "") {
            droppedParams.push({ name: lp, value: inst.params[lp] });
          }
        }
        return {
          macroId: inst.macroId,
          oldName: inst.name,
          schemaVersion: inst.schemaVersion,
          tokens,
          tokenSource,
          profileFieldIdentifier: (inst.params || {})[this.processor.sourceProfileFieldParam] || null,
          accountIds: null,        // populated by resolveIdentities
          unresolvedTokens: null,  // populated by resolveIdentities
          droppedParams,
          span: inst.span,
          selfClose: inst.selfClose,
        };
      });

      this.stats.pagesPlanned++;
      this.planManager.addPageToPlan(id, {
        cloudPageId: id,
        spaceKey,
        title,
        contentType: storagePage.type || "page",
        currentVersion,
        macros: macroPlans,
        backupPath: null,
        diffPath: null,
        completedVersion: null,
      });
    }, this.opts.concurrency);

    this.planManager.savePlan();
    this.log(`\nPlan saved: ${this.planManager.planFilePath}`);
    this.log(`  Pages planned:        ${this.stats.pagesPlanned}`);
    this.log(`  Macros found:         ${this.stats.macrosFound}`);
    return this.planManager.planFilePath;
  }

  // ─── PHASE 1.5: RESOLVE IDENTITIES ─────────────────────────────────

  async resolveIdentities() {
    if (!this.planManager.plan) return;
    const pages = Object.entries(this.planManager.plan.pages);

    // Primary Contact target: the --page-users-csv tokens ARE EntraID object
    // ids (ms-account-ids) already resolved offline against the Entra export.
    // No Jira user-search — pass them straight through as the macro identities.
    if (this.opts.targetApp === "contactperson") {
      let n = 0;
      for (const [, data] of pages) {
        for (const m of (data.macros || [])) {
          m.accountIds = [...(m.tokens || [])];
          m.unresolvedTokens = [];
          n += m.accountIds.length;
        }
      }
      this.planManager.savePlan();
      this.log(`\n[contactperson] Passed ${n} EntraID object-id token(s) through (no Jira resolution).`);
      return;
    }

    // Collect unique tokens across all planned pages
    const uniqueTokens = new Set();
    for (const [, data] of pages) {
      for (const m of (data.macros || [])) {
        for (const t of (m.tokens || [])) uniqueTokens.add(t);
      }
    }
    this.stats.uniqueTokens = uniqueTokens.size;
    this.log(`\nResolving ${uniqueTokens.size} unique user token(s) via Jira user-search...`);

    // resolveUser now returns string[] (empty=unresolved, [id]=single,
    // [a,b,...]=multi-match for same-name disambiguation).
    const resolved = new Map(); // token -> string[]
    let i = 0;
    for (const token of uniqueTokens) {
      i++;
      const ids = await this.resolver.resolveUser(token);
      resolved.set(token, ids);
      if (ids.length > 0) this.stats.tokensResolved++;
      else this.stats.tokensUnresolved++;
      if (i % 25 === 0 || i === uniqueTokens.size) {
        this.log(`  Resolver progress: ${i}/${uniqueTokens.size} (hits=${this.stats.tokensResolved}, misses=${this.stats.tokensUnresolved})`);
      }
    }

    // Project resolved accountIds back into each macro plan entry,
    // flattening multi-match tokens into multiple cards. Partial
    // resolution (some tokens resolved, others not) is OK — the page is
    // still processed with whatever we could resolve, and unresolved
    // tokens are logged to CSV for manual follow-up.
    for (const [pageId, data] of pages) {
      let pageHasUnresolved = false;
      for (const m of (data.macros || [])) {
        const accountIds = [];
        const unresolved = [];
        for (const t of (m.tokens || [])) {
          const ids = resolved.get(t) || [];
          if (ids.length > 0) accountIds.push(...ids);
          else unresolved.push(t);
        }
        m.accountIds = accountIds;
        m.unresolvedTokens = unresolved;
        if (unresolved.length > 0) {
          pageHasUnresolved = true;
          for (const t of unresolved) {
            this._appendCsv(
              this.unresolvedCsvPath,
              `${this._csvEsc(pageId)},${this._csvEsc(data.spaceKey)},${this._csvEsc(m.macroId)},${this._csvEsc(t)}\n`,
            );
          }
        }
      }
      if (pageHasUnresolved) this.stats.pagesWithUnresolved++;
    }

    this.planManager.savePlan();
    const rs = this.resolver.getStats();
    this.log(`  Resolver stats: ${JSON.stringify(rs)}`);
    this.log(`  Pages with at least one unresolved token: ${this.stats.pagesWithUnresolved} (logged to ${path.relative(this.scriptRoot, this.unresolvedCsvPath)})`);
  }

  // ─── PHASE 2: EXECUTE PLAN ─────────────────────────────────────────

  async executePlan(planFilePath) {
    if (planFilePath) this.planManager.loadPlan(planFilePath);
    if (!this.planManager.plan) this.planManager.loadPlan();
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

    // Partial-resolution policy: convert with WHATEVER users we managed
    // to resolve. Unresolved per-user tokens are logged to the
    // unresolved_users CSV (during resolveIdentities) so the user can
    // follow up manually. Only skip a macro if NONE of its users
    // resolved (cards[] would be empty). Skip the page entirely only
    // if ALL its macros have empty cards[].
    const macrosWithUsers = (plannedMacros || []).filter(
      (m) => Array.isArray(m.accountIds) && m.accountIds.length > 0,
    );
    if (macrosWithUsers.length === 0) {
      this.planManager.updatePageStatus(pageId, "skipped", "all-macros-have-zero-resolved-users");
      this.stats.pagesSkipped++;
      this.log(`    "${title}" (Cloud: ${pageId}): SKIPPED — no macro had any resolved users`);
      return;
    }
    // Note partial resolutions so the user can see them in the log
    for (const m of (plannedMacros || [])) {
      if (Array.isArray(m.unresolvedTokens) && m.unresolvedTokens.length > 0
          && Array.isArray(m.accountIds) && m.accountIds.length > 0) {
        this.log(`    "${title}" (Cloud: ${pageId}): partial — dropping ${m.unresolvedTokens.length} unresolved user(s) [${m.unresolvedTokens.join(", ")}], keeping ${m.accountIds.length}`);
      }
    }

    // Re-fetch fresh storage so we splice into the current page, not
    // the snapshot from plan time.
    const sp = await this.cloudClient.getPageStorage(pageId);
    const storage = sp.body?.storage?.value || "";
    const freshVersion = sp.version?.number;
    if (!storage || !freshVersion) {
      this.planManager.updatePageStatus(pageId, "failed", "empty-storage-or-version");
      this.stats.pagesFailed++;
      return;
    }

    const freshInstances = this.processor.findCandidateMacros(storage);

    // Match planned macros to fresh instances by macroId (preferred) or
    // ordinal fallback. Build the resolver map keyed the same way
    // rewriteStorage expects.
    const accountIdsByMacroKey = {};
    const instancesToUse = [];
    let ordinalIdx = 0;
    for (const planned of plannedMacros) {
      if (!Array.isArray(planned.accountIds) || planned.accountIds.length === 0) continue;
      let matched = null;
      if (planned.macroId) {
        matched = freshInstances.find(
          (fi) => fi.macroId === planned.macroId && fi.name === planned.oldName,
        );
      }
      if (!matched) {
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
      if (matched) {
        const key = matched.macroId ? `mid:${matched.macroId}` : `span:${matched.span[0]}`;
        accountIdsByMacroKey[key] = planned.accountIds;
        instancesToUse.push(matched);
      }
    }

    if (instancesToUse.length === 0) {
      // Distinguish the two reasons this can fire:
      //  (a) no macro on the page had any resolved accountIds (most common
      //      cause: no row in --page-users-csv matched this page's
      //      space/title/macroId)
      //  (b) the fresh storage walk found no macro by the planned macroId
      //      (the page was independently edited and the macro was changed
      //      or removed)
      const anyHadAccountIds = (plannedMacros || []).some(
        (m) => Array.isArray(m.accountIds) && m.accountIds.length > 0,
      );
      const reason = anyHadAccountIds
        ? "no-matching-instances-in-fresh-storage"
        : "no-resolved-accountids";
      const human = anyHadAccountIds
        ? "macros disappeared from fresh storage (page may have been independently edited)"
        : "no CSV row matched this Cloud page (by macroId, space+title, or pageId)";
      this.planManager.updatePageStatus(pageId, "skipped", reason);
      this.stats.pagesSkipped++;
      this.log(`    "${title}" (Cloud: ${pageId}): SKIPPED — ${human}`);
      return;
    }

    const { newXml, changes, lossyParamDrops } = this.processor.rewriteStorage(
      storage,
      instancesToUse,
      accountIdsByMacroKey,
    );

    if (newXml === storage) {
      this.planManager.updatePageStatus(pageId, "skipped", "no-op");
      this.stats.pagesSkipped++;
      this.log(`    "${title}" (Cloud: ${pageId}): no-op (already converted?)`);
      return;
    }

    // Append lossy-params CSV before PUT so it's recorded even if PUT fails.
    for (const drop of (lossyParamDrops || [])) {
      this._appendCsv(
        this.lossyCsvPath,
        `${this._csvEsc(pageId)},${this._csvEsc(data.spaceKey)},${this._csvEsc(drop.macroId)},${this._csvEsc(drop.paramName)},${this._csvEsc(drop.droppedValue)}\n`,
      );
    }

    let backupPath = null;
    let diffPath = null;
    let metaPath = null;
    if (!this.opts.noBackup) {
      backupPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.xhtml`);
      diffPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.diff.patch`);
      metaPath = path.join(this.backupDir, `page_${pageId}_v${freshVersion}.meta.json`);
      try {
        if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, storage, "utf8");
        const diff = this.processor.unifiedDiff(storage, newXml);
        if (!fs.existsSync(diffPath)) fs.writeFileSync(diffPath, diff, "utf8");
        if (!fs.existsSync(metaPath)) {
          fs.writeFileSync(metaPath, JSON.stringify({
            cloudPageId: pageId,
            spaceKey: data.spaceKey,
            title,
            plannedVersion,
            currentVersion: freshVersion,
            postPutVersion: freshVersion + 1,
            runId: this.planManager.plan?.runId || null,
            sha1Before: crypto.createHash("sha1").update(storage).digest("hex"),
            sha1After: crypto.createHash("sha1").update(newXml).digest("hex"),
            changesCount: changes.length,
            lossyParamDropsCount: (lossyParamDrops || []).length,
          }, null, 2), "utf8");
        }
      } catch (e) {
        this.log(`    "${title}" (Cloud: ${pageId}): backup write failed: ${e.message} (proceeding anyway)`);
      }
    }

    if (this.opts.dryRun) {
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
    this.log("\nStep 5: Post-run verification...");

    const sourceQuoted = this.processor.sourceMacroNames.map((n) => `"${n}"`).join(",");
    const targetQuoted = `"${this.processor.targetMacroName}"`;

    const spaceClause = this.opts.spaceKeys.length > 0
      ? `space in (${this.opts.spaceKeys.map((k) => `"${k}"`).join(",")}) AND `
      : "";

    const residualCql = `${spaceClause}macro in (${sourceQuoted}) AND type = page`;
    const landedCql = `${spaceClause}macro in (${targetQuoted}) AND type = page`;

    let residual = 0, landed = 0;
    await this.cloudClient.searchContentByCql(residualCql, "version", async (results) => {
      residual += results.length;
    });
    await this.cloudClient.searchContentByCql(landedCql, "version", async (results) => {
      landed += results.length;
    });

    this.log(`  Residual responsibility pages: ${residual} (CQL: ${residualCql})`);
    this.log(`  Landed aura-user-profile pages: ${landed}`);
    if (residual > this.stats.pagesWithUnresolved + this.stats.pagesFailed + this.stats.pagesSkipped) {
      this.log(`  WARNING: residual count exceeds (unresolved + failures + skipped); investigate.`);
    }
  }

  // ─── ENTRY ────────────────────────────────────────────────────────

  async run() {
    await this.testConnection();

    if (this.opts.discoveryDump) {
      this.log("\nDISCOVERY MODE: CQL-search + raw storage dump only. No plan, no rewrites.");
      await this.discoveryDump();
      return;
    }

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
      this.log("\nStep 3: Resolving user identities...");
      await this.resolveIdentities();
      if (this.opts.planOnly) {
        this.log(`\nPLAN-ONLY MODE: stopping. Plan at ${planPath}`);
        return;
      }
      this.log("\nStep 4: Executing plan...");
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
    sync = new ResponsibilityToAuraSync(opts);
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
