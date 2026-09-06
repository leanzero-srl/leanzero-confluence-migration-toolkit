#!/usr/bin/env node

/**
 * Read-only diagnostic for Scaffolding/Reporting-affected pages.
 *
 * Pulls a sample of pages from the existing plan whose nestings touch
 * ServiceRocket Scaffolding or Reporting Bundle macros, fetches each
 * page's rendered ADF from Cloud, and inspects the ADF for migration
 * error markers (`unsupportedInline`, `unsupportedBlock`, the literal
 * `confluenceADFMigrationUnsupportedContentInternalExtension` string,
 * and `unsupported-content` placeholders inside extension metadata).
 *
 * Critical output: per error marker, the **context** — i.e. which
 * macro WRAPS the error in the ADF tree. This is what differentiates:
 *   - "error AT the wrapper boundary" (parent is panel/expand/info)
 *     → un-nester CAN fix it. Proceed to Phase B/C.
 *   - "error INSIDE Scaffolding's body" (parent is list-data/report-block/...)
 *     → un-nester CANNOT fix. Recommend ServiceRocket Cloud migration tools.
 *
 * No PUTs. No mutations. Safe to run any time.
 *
 * Usage:
 *   node --max-old-space-size=4096 tools/diagnose_scaffolding.js \
 *     --plan-file logs/plan_1778319038952.json
 *
 * Optional flags:
 *   --per-space <N>    pages to sample per space (default: 20)
 *   --max-pages <N>    overall cap (default: 200)
 *   --seed <N>         RNG seed for reproducible sampling (default: 42)
 *   --space <KEY>      restrict to space(s); repeatable or comma-separated
 *
 * Outputs:
 *   logs/scaffolding_diagnostic_<ts>.json
 *   logs/scaffolding_diagnostic_<ts>.csv
 *   Console summary table
 *
 * Patterns reused:
 *   - mulberry32 seeded RNG: confluence/visibility-macro/diag_validate_fix.js:10-18
 *   - ADF fetch + JSON.parse: confluence/visibility-macro/diag_check_writes.js:55-65
 *   - Plan iteration: confluence/nested-macro/tools/rewrite_plan_excluded.js:161-184
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

// ─── Config ──────────────────────────────────────────────────────────

// ServiceRocket Scaffolding Forms macro family. These are the macros
// we deliberately EXCLUDED from the un-nest run; the diagnostic only
// looks at pages that touch any of these.
const SCAFFOLDING_MACROS = new Set([
  "list-data", "list-option",
  "text-data", "date-data", "excerpt-data", "select-data", "radio-data",
  "checkbox-data", "attachment-data", "user-data", "live-template",
  "text-input", "excerpt-include",
]);

// ServiceRocket Reporting Bundle macro family. Same deal — excluded
// from un-nest, included in diagnostic candidate pool.
const REPORTING_MACROS = new Set([
  "report-block", "report-body", "report-info", "report-empty",
  "report-on", "report-table", "report-column",
  "local-reporter", "text-filter", "date-filter", "select-filter",
  "user-filter", "label-filter", "page-properties-filter",
  "and-filter", "or-filter",
]);

const TARGET_MACROS = new Set([...SCAFFOLDING_MACROS, ...REPORTING_MACROS]);

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    perSpace: 20,
    maxPages: 200,
    seed: 42,
    spaceKeys: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
        showHelp();
        process.exit(0);
      case "--plan-file":
        out.planFile = args[++i];
        break;
      case "--per-space":
        out.perSpace = parseInt(args[++i], 10);
        break;
      case "--max-pages":
        out.maxPages = parseInt(args[++i], 10);
        break;
      case "--seed":
        out.seed = parseInt(args[++i], 10);
        break;
      case "--space": {
        const v = args[++i];
        if (v) out.spaceKeys.push(...v.split(",").map(s => s.trim()).filter(Boolean));
        break;
      }
      default:
        if (a.startsWith("--")) console.warn(`Unknown option: ${a}`);
        break;
    }
  }
  return out;
}

function showHelp() {
  console.log(`
Read-only diagnostic for Scaffolding/Reporting-affected pages.

Usage:
  node --max-old-space-size=4096 tools/diagnose_scaffolding.js [options]

Required:
  --plan-file <path>   Plan JSON to read

Optional:
  --per-space <N>      Pages to sample per space (default: 20)
  --max-pages <N>      Overall sample cap (default: 200)
  --seed <N>           RNG seed for reproducibility (default: 42)
  --space <KEY>        Restrict to space(s) — repeatable or comma-separated
  --help               This message

Outputs (under logs/):
  scaffolding_diagnostic_<ts>.json   Full per-page records
  scaffolding_diagnostic_<ts>.csv    Flat one-row-per-page

Examples:
  # Default diagnostic on all spaces, 20/space, 200 max
  node --max-old-space-size=4096 tools/diagnose_scaffolding.js \\
    --plan-file logs/plan_1778319038952.json

  # Focus on the 'sick' space heavily
  node --max-old-space-size=4096 tools/diagnose_scaffolding.js \\
    --plan-file logs/plan_1778319038952.json --space sick --per-space 50

  # Wider scan
  node --max-old-space-size=4096 tools/diagnose_scaffolding.js \\
    --plan-file logs/plan_1778319038952.json --per-space 30 --max-pages 500
`);
}

// ─── Seeded RNG (mulberry32) — for reproducible sampling ─────────────

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── ADF walker ──────────────────────────────────────────────────────

/**
 * Walk the ADF tree, classifying each node and tracking ancestor macro
 * names so we can describe the context of any error marker we find.
 *
 * Returns:
 *   {
 *     errors: [{type, ancestorMacros[], near, snippet}],
 *     macrosFound: [{name, count}],
 *     totalNodes: N,
 *   }
 *
 * Where:
 *   - `type` is the ADF marker type or our defensive substring class
 *   - `ancestorMacros` is the chain of macro extensionKeys from root
 *     down to (but not including) the error node — answers
 *     "what macro wraps this error?"
 *   - `near` is a short label for the immediate parent (most useful)
 *   - `snippet` is up to 200 chars of the offending node JSON for audit
 */
function walkAdf(adf) {
  const errors = [];
  const macrosFound = new Map();
  let totalNodes = 0;

  function macroNameOf(node) {
    // ADF extension nodes carry the macro name in attrs.extensionKey.
    const ek = node?.attrs?.extensionKey;
    if (!ek) return null;
    return ek;
  }

  function isExtensionNode(node) {
    return node?.type === "extension"
        || node?.type === "bodiedExtension"
        || node?.type === "inlineExtension";
  }

  function isUnsupportedNode(node) {
    return node?.type === "unsupportedInline" || node?.type === "unsupportedBlock";
  }

  function isMigrationUnsupportedExtension(node) {
    if (!isExtensionNode(node)) return false;
    // PRIMARY SHAPE: Confluence's actual migration-error node uses
    //   attrs.extensionType = "com.atlassian.confluence.migration"
    //   attrs.extensionKey  = "__confluenceADFMigrationUnsupportedContentInternalExtension__"
    // The original storage XML is in attrs.parameters.cxhtml.
    //
    // IMPORTANT: extensionType "com.atlassian.confluence.migration" alone
    // is NOT enough — that namespace ALSO contains `legacy-content`, which
    // is Cloud's HTML fallback rendering (page renders fine, no editor
    // banner). Only flag when the extensionKey specifically indicates
    // unsupported content. Verified on staff pages 123456790 (real
    // unsupported) and 205955724 (65 legacy-content nodes, no actual
    // editor error).
    const extKey = node?.attrs?.extensionKey || "";
    if (typeof extKey === "string"
        && (extKey.includes("UnsupportedContentInternalExtension")
            || extKey.includes("migrationUnsupportedContent"))) {
      return true;
    }
    // SECONDARY SHAPE: standard macro extension with an "unsupported-content"
    // placeholder under macroMetadata. Less common but documented.
    const meta = node?.attrs?.parameters?.macroMetadata;
    const ph = meta?.placeholder;
    if (Array.isArray(ph)) {
      for (const p of ph) {
        if (p && (p.type === "unsupported-content"
                || (typeof p.data === "string" && p.data.toLowerCase().includes("unsupported")))) {
          return true;
        }
      }
    }
    if (ph && typeof ph === "object" && !Array.isArray(ph)) {
      if (ph.type === "unsupported-content"
          || (typeof ph.data === "string" && ph.data.toLowerCase().includes("unsupported"))) {
        return true;
      }
    }
    const title = meta?.title?.value;
    if (typeof title === "string" && title.toLowerCase().includes("unsupported")) {
      return true;
    }
    return false;
  }

  /**
   * For migration-error nodes, the inner macro that COULDN'T be converted
   * is encoded in attrs.parameters.cxhtml (storage XML). Extract it so
   * the "near" / "context" fields can describe the real failure point,
   * not just "this is a migration extension".
   */
  function extractInnerMacroFromMigrationError(node) {
    const cxhtml = node?.attrs?.parameters?.cxhtml;
    if (typeof cxhtml !== "string") return null;
    // First occurrence of ac:name="..." inside the storage snippet.
    const m = cxhtml.match(/ac:name="([^"]+)"/);
    return m ? m[1] : null;
  }

  function shortSnippet(node) {
    try {
      return JSON.stringify(node).slice(0, 200);
    } catch {
      return "<unserialisable>";
    }
  }

  function walk(node, ancestorMacros) {
    if (!node || typeof node !== "object") return;
    totalNodes++;

    // Track macros we see anywhere on the page.
    if (isExtensionNode(node)) {
      const name = macroNameOf(node);
      if (name) {
        macrosFound.set(name, (macrosFound.get(name) || 0) + 1);
      }
    }

    // Classify error markers.
    let errorType = null;
    let failedMacro = null;
    if (isUnsupportedNode(node)) errorType = node.type;
    else if (isMigrationUnsupportedExtension(node)) {
      errorType = "migrationUnsupported";
      failedMacro = extractInnerMacroFromMigrationError(node);
    }

    if (errorType) {
      errors.push({
        type: errorType,
        // What macro Cloud failed to convert (extracted from cxhtml param)
        failedMacro,
        // Ancestor chain in the ADF — the macro that WRAPS this error.
        // For migration errors, this is what we use to decide whether the
        // un-nester can help (boundary) or not (Scaffolding-internal).
        ancestorMacros: [...ancestorMacros],
        near: ancestorMacros.length > 0 ? ancestorMacros[ancestorMacros.length - 1] : "(root)",
        snippet: shortSnippet(node),
      });
    }

    // Build the new ancestor chain for this node's children.
    let nextAncestors = ancestorMacros;
    if (isExtensionNode(node)) {
      const name = macroNameOf(node) || node.type;
      nextAncestors = [...ancestorMacros, name];
    }

    // Recurse into both `content` (block/inline children) and any other
    // array fields that may contain nodes.
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child, nextAncestors);
    }
    // bodiedExtension / extension may also nest content; covered above.
    // Marks (text formatting) shouldn't contain extensions but walk just
    // in case.
    if (Array.isArray(node.marks)) {
      for (const m of node.marks) walk(m, nextAncestors);
    }
  }

  walk(adf, []);

  return {
    errors,
    macrosFound: [...macrosFound.entries()].map(([name, count]) => ({ name, count })),
    totalNodes,
  };
}

/**
 * Defensive belt-and-braces: if the raw JSON contains the literal
 * marker substring used by Confluence's migration error, treat the
 * page as having an error even if our structural classifier missed it.
 * This catches whatever node shape Cloud is currently emitting; the
 * unsupported-content ADF surface is undocumented and changes.
 */
function rawSubstringHasMigrationError(rawJson) {
  if (typeof rawJson !== "string") return false;
  return rawJson.includes("confluenceADFMigrationUnsupportedContentInternalExtension")
      || rawJson.includes("UnsupportedContentInternalExtension")
      || rawJson.includes("migrationUnsupportedContent");
}

// ─── Plan helpers ────────────────────────────────────────────────────

function pageTargetsScaffolding(page) {
  if (!Array.isArray(page.nestings)) return false;
  for (const n of page.nestings) {
    if (TARGET_MACROS.has(n.outerMacro) || TARGET_MACROS.has(n.innerMacro)) {
      return true;
    }
  }
  return false;
}

function buildCandidatePool(plan, spaceFilter) {
  // Per the rewrite tool, all Scaffolding/Reporting nestings are now
  // strategy=skip. Candidate = page with ANY nesting touching a target
  // macro, regardless of strategy field, since strategy alone isn't
  // a clean predicate (the same page can have mixed strategies).
  const pool = [];
  const filterSet = spaceFilter && spaceFilter.length > 0 ? new Set(spaceFilter) : null;
  for (const [pageId, page] of Object.entries(plan.pages || {})) {
    if (filterSet && !filterSet.has(page.spaceKey)) continue;
    if (!pageTargetsScaffolding(page)) continue;
    pool.push({ pageId, page });
  }
  return pool;
}

function sampleByBucket(pool, perSpace, maxPages, rng) {
  const buckets = new Map();
  for (const p of pool) {
    const k = p.page.spaceKey || "(no-space)";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  const sampled = [];
  // Iterate in descending bucket size so heavy spaces (sick) get sampled first.
  const sortedKeys = [...buckets.keys()].sort((a, b) => buckets.get(b).length - buckets.get(a).length);
  for (const k of sortedKeys) {
    if (sampled.length >= maxPages) break;
    const bucket = buckets.get(k);
    const want = Math.min(perSpace, bucket.length, maxPages - sampled.length);
    const taken = new Set();
    while (taken.size < want) {
      const idx = Math.floor(rng() * bucket.length);
      if (taken.has(idx)) continue;
      taken.add(idx);
      sampled.push(bucket[idx]);
    }
  }
  return { sampled, bucketSizes: sortedKeys.map(k => ({ space: k, total: buckets.get(k).length })) };
}

// ─── Page diagnostic ─────────────────────────────────────────────────

async function diagnosePage(cloud, pageId) {
  let page;
  try {
    page = await cloud.getPageAdf(pageId);
  } catch (err) {
    return {
      ok: false,
      error: `fetch: ${err.message}`,
    };
  }
  const rawAdf = page?.body?.atlas_doc_format?.value;
  if (typeof rawAdf !== "string") {
    return {
      ok: false,
      error: "no atlas_doc_format body returned",
      title: page?.title,
      spaceKey: page?.space?.key,
      version: page?.version?.number,
    };
  }

  let adf;
  try {
    adf = JSON.parse(rawAdf);
  } catch (err) {
    return {
      ok: false,
      error: `adf parse: ${err.message}`,
      title: page?.title,
      spaceKey: page?.space?.key,
      version: page?.version?.number,
    };
  }

  const walk = walkAdf(adf);
  const rawMatch = rawSubstringHasMigrationError(rawAdf);

  return {
    ok: true,
    title: page?.title,
    spaceKey: page?.space?.key,
    version: page?.version?.number,
    totalNodes: walk.totalNodes,
    errors: walk.errors,
    macrosFound: walk.macrosFound,
    rawMarkerHit: rawMatch,
  };
}

// ─── Output ──────────────────────────────────────────────────────────

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function classifyContext(errors) {
  // Decide A.1 / A.2 / A.3 per page based on what wraps the errors.
  // - "boundary": at least one error has its NEAREST macro ancestor as
  //   a non-Scaffolding/Reporting macro — un-nester CAN help.
  // - "internal": at least one error has its nearest ancestor as a
  //   Scaffolding/Reporting macro — un-nester CANNOT help that error.
  // - "mixed": both kinds present.
  // - "no-error": no errors at all.
  if (!errors || errors.length === 0) return "no-error";
  let boundary = false, internal = false;
  for (const e of errors) {
    const near = e.near;
    if (near === "(root)") {
      // Top-level error — no wrapping macro. Treat as boundary (un-nester
      // doesn't apply, but neither does Scaffolding-internal — separate
      // class. For simplicity, count as boundary.)
      boundary = true;
      continue;
    }
    if (TARGET_MACROS.has(near)) internal = true;
    else boundary = true;
  }
  if (boundary && internal) return "mixed";
  if (boundary) return "boundary";
  if (internal) return "internal";
  return "no-error";
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (!opts.planFile) {
    console.error("ERROR: --plan-file is required\n");
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
  console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const pool = buildCandidatePool(plan, opts.spaceKeys);
  console.log(`Candidate pool: ${pool.length.toLocaleString()} pages touch Scaffolding/Reporting macros`);
  if (pool.length === 0) {
    console.log("Nothing to diagnose — exit.");
    return;
  }

  const rng = mulberry32(opts.seed);
  const { sampled, bucketSizes } = sampleByBucket(pool, opts.perSpace, opts.maxPages, rng);
  console.log(`\nBuckets (top 20):`);
  for (const b of bucketSizes.slice(0, 20)) {
    console.log(`  ${String(b.space).padEnd(30)} ${b.total.toLocaleString()} pages`);
  }
  console.log(`\nSampling ${sampled.length} page(s) (per-space=${opts.perSpace}, max=${opts.maxPages}, seed=${opts.seed})\n`);

  // Required env
  for (const k of ["CLOUD_BASE_URL", "CLOUD_EMAIL", "CLOUD_API_TOKEN"]) {
    if (!process.env[k]) {
      console.error(`ERROR: ${k} not set in .env`);
      process.exit(1);
    }
  }

  const cloud = new CloudConfluenceClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  // Quick connection test
  const ok = await cloud.testConnection();
  if (!ok) {
    console.error("ERROR: Cloud connection test failed");
    process.exit(1);
  }
  console.log("Cloud connection OK\n");

  const records = [];
  let progress = 0;
  const total = sampled.length;

  for (const item of sampled) {
    progress++;
    const result = await diagnosePage(cloud, item.pageId);
    const plannedNestings = (item.page.nestings || []).map(n => n.path);
    const rec = {
      pageId: item.pageId,
      spaceKey: item.page.spaceKey,
      planTitle: item.page.title,
      ...result,
      plannedNestings,
      planNestingCount: plannedNestings.length,
    };
    rec.classification = result.ok ? classifyContext(result.errors) : "fetch-error";
    records.push(rec);

    if (progress % 10 === 0 || progress === total) {
      const live = records.filter(r => r.ok && r.errors && r.errors.length > 0).length;
      console.log(`  [${progress}/${total}] sampled — ${live} so far have ADF errors`);
    }
  }

  // ─── Write outputs ─────────────────────────────────────────────────
  const ts = Date.now();
  const logsDir = path.resolve(__dirname, "../logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const jsonPath = path.join(logsDir, `scaffolding_diagnostic_${ts}.json`);
  const csvPath = path.join(logsDir, `scaffolding_diagnostic_${ts}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    runAt: new Date().toISOString(),
    planFile: planPath,
    seed: opts.seed,
    perSpace: opts.perSpace,
    maxPages: opts.maxPages,
    spaceFilter: opts.spaceKeys,
    sampleSize: records.length,
    poolSize: pool.length,
    records,
  }, null, 2));

  // CSV: one row per page, flat
  const csvRows = [["pageId","spaceKey","title","ok","classification","errorCount","errorTypes","errorWraps","scaffoldingMacrosOnPage","rawMarkerHit","planNestingCount","fetchError"]];
  for (const r of records) {
    const errorTypes = r.ok && r.errors ? [...new Set(r.errors.map(e => e.type))].join("|") : "";
    const errorWraps = r.ok && r.errors ? [...new Set(r.errors.map(e => e.near))].join("|") : "";
    const scafOnPage = r.ok && r.macrosFound
      ? r.macrosFound.filter(m => TARGET_MACROS.has(m.name)).map(m => `${m.name}:${m.count}`).join("|")
      : "";
    csvRows.push([
      r.pageId,
      r.spaceKey,
      r.title || r.planTitle || "",
      r.ok,
      r.classification,
      r.ok ? (r.errors?.length || 0) : "",
      errorTypes,
      errorWraps,
      scafOnPage,
      r.rawMarkerHit ? "yes" : "",
      r.planNestingCount,
      r.ok ? "" : (r.error || ""),
    ].map(csvEscape).join(","));
  }
  fs.writeFileSync(csvPath, csvRows.map(r => Array.isArray(r) ? r : [r]).map(r => Array.isArray(r) ? r.join(",") : r).join("\n"));

  // ─── Console summary ───────────────────────────────────────────────
  const okCount = records.filter(r => r.ok).length;
  const fetchErr = records.length - okCount;
  const byClass = { "no-error": 0, "boundary": 0, "internal": 0, "mixed": 0, "fetch-error": 0 };
  for (const r of records) byClass[r.classification] = (byClass[r.classification] || 0) + 1;
  const rawHits = records.filter(r => r.rawMarkerHit).length;

  console.log("\n" + "=".repeat(70));
  console.log("DIAGNOSTIC SUMMARY");
  console.log("=".repeat(70));
  console.log(`  Sampled pages:              ${records.length}`);
  console.log(`  ADF fetched OK:             ${okCount}`);
  console.log(`  Fetch errors:               ${fetchErr}`);
  console.log("");
  console.log(`  Classification:`);
  console.log(`    no-error  (no markers):                    ${byClass["no-error"]}`);
  console.log(`    boundary  (errors WRAP Scaffolding):       ${byClass["boundary"]}   <-- un-nester CAN fix`);
  console.log(`    internal  (errors INSIDE Scaffolding):     ${byClass["internal"]}   <-- un-nester CANNOT fix`);
  console.log(`    mixed     (both):                          ${byClass["mixed"]}`);
  console.log(`    fetch-error:                               ${byClass["fetch-error"]}`);
  console.log("");
  console.log(`  Defensive raw-substring marker hits:         ${rawHits} pages`);
  console.log("");
  console.log("  By space (top 15):");
  const bySpace = new Map();
  for (const r of records) {
    const k = r.spaceKey || "(unknown)";
    if (!bySpace.has(k)) bySpace.set(k, { total: 0, withErrors: 0, boundary: 0, internal: 0, mixed: 0 });
    const b = bySpace.get(k);
    b.total++;
    if (r.classification !== "no-error" && r.classification !== "fetch-error") b.withErrors++;
    if (r.classification === "boundary") b.boundary++;
    if (r.classification === "internal") b.internal++;
    if (r.classification === "mixed") b.mixed++;
  }
  const sortedSpaces = [...bySpace.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 15);
  console.log(`    ${"space".padEnd(20)}  ${"sampled".padStart(8)}  ${"errors".padStart(8)}  ${"bound".padStart(6)}  ${"intern".padStart(6)}  ${"mixed".padStart(6)}`);
  for (const [k, b] of sortedSpaces) {
    console.log(`    ${String(k).padEnd(20)}  ${String(b.total).padStart(8)}  ${String(b.withErrors).padStart(8)}  ${String(b.boundary).padStart(6)}  ${String(b.internal).padStart(6)}  ${String(b.mixed).padStart(6)}`);
  }

  // Top wrappers near errors — answers "what macros wrap the errors most?"
  const wrapHits = new Map();
  const failHits = new Map();
  for (const r of records) {
    if (!r.ok || !r.errors) continue;
    for (const e of r.errors) {
      wrapHits.set(e.near, (wrapHits.get(e.near) || 0) + 1);
      if (e.failedMacro) failHits.set(e.failedMacro, (failHits.get(e.failedMacro) || 0) + 1);
    }
  }
  if (wrapHits.size > 0) {
    console.log("\n  Top macros WRAPPING errors (parent in ADF tree):");
    const sortedWraps = [...wrapHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [name, count] of sortedWraps) {
      const tag = TARGET_MACROS.has(name) ? "[Scaffolding/Reporting]" : "[other]";
      console.log(`    ${String(name).padEnd(28)}  ${String(count).padStart(6)}   ${tag}`);
    }
  }
  if (failHits.size > 0) {
    console.log("\n  Top macros that FAILED to convert (from cxhtml in migration error):");
    const sortedFails = [...failHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [name, count] of sortedFails) {
      const tag = TARGET_MACROS.has(name) ? "[Scaffolding/Reporting]" : "[other]";
      console.log(`    ${String(name).padEnd(28)}  ${String(count).padStart(6)}   ${tag}`);
    }
  }

  console.log("\n  Outputs:");
  console.log(`    JSON: ${jsonPath}`);
  console.log(`    CSV:  ${csvPath}`);
  console.log("=".repeat(70));

  // Recommended branch
  console.log("");
  const wrappingTargets = [...wrapHits.entries()].filter(([name]) => TARGET_MACROS.has(name)).reduce((a, [, c]) => a + c, 0);
  const wrappingOther = [...wrapHits.entries()].filter(([name]) => !TARGET_MACROS.has(name) && name !== "(root)").reduce((a, [, c]) => a + c, 0);
  const wrapTotal = wrappingTargets + wrappingOther;
  if (wrapTotal === 0) {
    console.log("  RECOMMENDATION: No errors detected in sample — Scaffolding pages are likely fine in Cloud. The current");
    console.log("                  excluded list is correct as-is. Phases B/C of the plan are NOT needed.");
  } else if (wrappingOther / wrapTotal >= 0.7) {
    console.log("  RECOMMENDATION: Branch A.1 — most errors WRAP Scaffolding macros at the boundary.");
    console.log("                  The un-nester CAN help. Proceed to Phase B (refined exclusion model) + Phase C (canary).");
  } else if (wrappingTargets / wrapTotal >= 0.7) {
    console.log("  RECOMMENDATION: Branch A.2 — most errors are INSIDE Scaffolding macro bodies.");
    console.log("                  The un-nester CANNOT help. Recommend ServiceRocket Cloud Migration Assistant,");
    console.log("                  app reinstall, or re-authoring. Do NOT proceed to Phase B/C.");
  } else {
    console.log("  RECOMMENDATION: Branch A.3 — mixed. Errors split between boundary and internal.");
    console.log("                  Phase B/C may help SOME pages; the boundary ones. Proceed cautiously and filter");
    console.log("                  the canary to pages whose errors are at the boundary.");
  }
  console.log("");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = { walkAdf, classifyContext, mulberry32, TARGET_MACROS, SCAFFOLDING_MACROS, REPORTING_MACROS };
