#!/usr/bin/env node

/**
 * Grant-space-admin: add the current API-token user as an administrator
 * on every Confluence Cloud space. Additive only — does not touch existing
 * permissions. Idempotent — skips spaces where we already hold the target
 * permissions.
 *
 * Uses:
 *   GET  /wiki/rest/api/user/current              → our accountId
 *   GET  /wiki/api/v2/spaces                      → list all spaces
 *   GET  /wiki/api/v2/spaces/{id}/permissions     → read existing perms
 *   POST /wiki/rest/api/space/{spaceKey}/permission → grant a permission
 *
 * The v1 permission-grant endpoint is the only documented way to add space
 * permissions from a user API token. It requires either space-admin or
 * site-admin (Administer Confluence) on the caller. Apps/Forge cannot use
 * this endpoint (Basic-auth user tokens can).
 *
 * Granted operations (by default, a full admin-equivalent set):
 *   administer:space   (space admin — the most important)
 *   read:space         (needed for basic visibility)
 *
 * Other operations (create/delete/export/archive/restrict_content) are
 * implied by administer but added opt-in via --full-grant for belt-and-suspenders.
 *
 * Flags:
 *   --dry-run              Preview only, no POSTs
 *   --space <KEY>          Restrict to specific space(s), repeatable
 *   --skip-personal        Do not touch personal spaces (keys starting with ~)
 *   --full-grant           Grant the entire permission set, not just admin+read
 *   --concurrency <N>      Parallel grant workers (default: 3)
 *   --help                 Show help
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudClient = require("../src/cloudClient");

// Operation pairs accepted by /wiki/rest/api/space/{key}/permission. Sourced
// from the Atlassian developer documentation (v1 Space Permissions).
// Order matters: Confluence enforces that `read:space` must exist for a
// principal before any other permission can be added. Put `read` first.
const CORE_OPS = [
  { key: "read", target: "space" },
  { key: "administer", target: "space" },
];

const FULL_OPS = [
  { key: "read", target: "space" },
  { key: "administer", target: "space" },
  { key: "create", target: "page" },
  { key: "create", target: "blogpost" },
  { key: "create", target: "comment" },
  { key: "create", target: "attachment" },
  { key: "delete", target: "page" },
  { key: "delete", target: "blogpost" },
  { key: "delete", target: "comment" },
  { key: "delete", target: "attachment" },
  { key: "delete", target: "space" },
  { key: "export", target: "space" },
  { key: "archive", target: "page" },
  { key: "restrict_content", target: "space" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { spaceKeys: [], concurrency: 3 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": showHelp(); process.exit(0);
      case "--dry-run": opts.dryRun = true; break;
      case "--skip-personal": opts.skipPersonal = true; break;
      case "--full-grant": opts.fullGrant = true; break;
      case "--space": {
        const v = args[++i];
        if (v) opts.spaceKeys.push(...v.split(",").map((k) => k.trim()).filter(Boolean));
        break;
      }
      case "--concurrency": opts.concurrency = parseInt(args[++i], 10) || 3; break;
      default:
        if (args[i].startsWith("--")) console.warn(`Unknown flag: ${args[i]}`);
    }
  }
  return opts;
}

function showHelp() {
  console.log(`
Grant Space Admin — Confluence Cloud

Adds the current API-token user as an administrator on every Confluence Cloud
space (or a subset via --space). Additive only: existing permissions are
preserved. Idempotent.

Usage:
  node main/grant_space_admin.js [options]

Options:
  --dry-run              Preview without granting
  --space <KEY>          Restrict to specific space(s), repeatable or comma-sep
  --skip-personal        Exclude personal spaces (keys starting with ~)
  --full-grant           Grant full admin-equivalent permission set
                         (otherwise just administer:space + read:space)
  --concurrency <N>      Parallel workers (default: 3)
  --help                 Show this help
`);
}

async function main() {
  const opts = parseArgs();

  const required = ["CLOUD_BASE_URL", "CLOUD_EMAIL", "CLOUD_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(", ")}. Copy .env.example to .env.`);
    process.exit(1);
  }

  const logDir = path.join(__dirname, "../logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `grant_${Date.now()}.log`);
  fs.writeFileSync(logFile, `Grant space admin\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`);

  const log = (m) => {
    console.log(m);
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ }
  };

  log("==============================================");
  log("Grant Space Admin — Confluence Cloud");
  log("==============================================");
  log(`  Cloud: ${process.env.CLOUD_BASE_URL}`);
  if (opts.dryRun) log("  *** DRY RUN — no POSTs will be sent ***");
  log(`  Operation set: ${opts.fullGrant ? "FULL" : "CORE (administer+read)"}`);
  if (opts.spaceKeys.length) log(`  Restricted to: ${opts.spaceKeys.join(", ")}`);
  if (opts.skipPersonal) log(`  Skipping personal spaces`);
  log(`  Concurrency: ${opts.concurrency}`);
  log("");

  const c = new CloudClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_EMAIL,
    process.env.CLOUD_API_TOKEN,
  );

  log("Step 1: identifying current user...");
  let me;
  try {
    me = await c.getCurrentUser();
  } catch (e) {
    log(`FAIL getting current user: ${e.message}`);
    process.exit(1);
  }
  const accountId = me.accountId;
  const displayName = me.displayName || "(unknown)";
  log(`  accountId: ${accountId}`);
  log(`  displayName: ${displayName}`);
  log("");

  log("Step 2: listing spaces...");
  const allSpaces = [];
  await c.listAllSpaces(async (batch) => {
    allSpaces.push(...batch);
    log(`  Fetched ${allSpaces.length} spaces so far...`);
    return true;
  });
  log(`  Total spaces: ${allSpaces.length}`);

  let spaces = allSpaces;
  if (opts.spaceKeys.length > 0) {
    const keep = new Set(opts.spaceKeys);
    spaces = spaces.filter((s) => keep.has(s.key));
    log(`  Filter matched ${spaces.length} space(s)`);
  }
  if (opts.skipPersonal) {
    const before = spaces.length;
    spaces = spaces.filter((s) => !s.key.startsWith("~"));
    log(`  Skipping ${before - spaces.length} personal space(s)`);
  }

  const ops = opts.fullGrant ? FULL_OPS : CORE_OPS;
  const stats = { total: spaces.length, checked: 0, alreadyHave: 0, granted: 0, failed: 0, opsGranted: 0, opsSkipped: 0, opsFailed: 0 };
  const failureLog = [];

  log("");
  log(`Step 3: granting permissions across ${spaces.length} space(s)...\n`);

  const startTime = Date.now();

  // Worker pool
  let cursor = 0;
  const total = spaces.length;
  const workers = [];

  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      const space = spaces[i];
      await processSpace(c, space, accountId, ops, opts, log, stats, failureLog, i + 1, total);
    }
  }

  for (let w = 0; w < opts.concurrency; w++) workers.push(next());
  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log("=".repeat(60));
  log("FINAL REPORT");
  log("=".repeat(60));
  if (opts.dryRun) log("*** DRY RUN — no permissions granted ***\n");
  log(`Spaces total:            ${stats.total}`);
  log(`Spaces checked:          ${stats.checked}`);
  log(`Already had all ops:     ${stats.alreadyHave}`);
  log(`Granted new permissions: ${stats.granted}`);
  log(`Space failed:            ${stats.failed}`);
  log("");
  log(`Individual ops granted:  ${stats.opsGranted}`);
  log(`Individual ops skipped:  ${stats.opsSkipped}  (already existed)`);
  log(`Individual ops failed:   ${stats.opsFailed}`);
  log("");

  if (failureLog.length > 0) {
    log(`Failures (${failureLog.length}):`);
    for (const f of failureLog.slice(0, 30)) {
      log(`  ${f.spaceKey} op=${f.op}: ${f.error}`);
    }
    if (failureLog.length > 30) log(`  ...and ${failureLog.length - 30} more`);
    // Dump full failure list to a JSON file
    const failFile = path.join(logDir, `grant_failures_${Date.now()}.json`);
    fs.writeFileSync(failFile, JSON.stringify(failureLog, null, 2));
    log(`Full failures: ${failFile}`);
  }

  const api = c.getStats();
  log("");
  log(`API requests: ${api.requestCount} (${api.errorCount} errors, ${api.rateLimitCount} rate limits)`);
  log(`Elapsed:      ${elapsed}s`);
  log(`Log file:     ${logFile}`);
  log("=".repeat(60));
}

async function processSpace(c, space, accountId, ops, opts, log, stats, failures, ordinal, total) {
  const { id, key, name, type } = space;
  stats.checked++;

  // Read existing permissions
  let existing = [];
  try {
    existing = await c.getSpacePermissions(id);
  } catch (e) {
    stats.failed++;
    failures.push({ spaceKey: key, spaceId: id, op: "list", error: e.message });
    log(`  [${ordinal}/${total}] FAIL ${key} "${name}" — list permissions: ${e.message}`);
    return;
  }

  // Which of our target ops do we already hold?
  const held = new Set();
  for (const p of existing) {
    if (p.principal?.type === "user" && p.principal?.id === accountId) {
      const key = `${p.operation?.key}:${p.operation?.targetType}`;
      held.add(key);
    }
  }

  const missing = ops.filter(({ key, target }) => !held.has(`${key}:${target}`));

  if (missing.length === 0) {
    stats.alreadyHave++;
    log(`  [${ordinal}/${total}] OK   ${key.padEnd(12)} "${name.substring(0, 50)}" — already holds all ops`);
    return;
  }

  if (opts.dryRun) {
    stats.granted++;
    stats.opsGranted += missing.length;
    log(`  [${ordinal}/${total}] DRY  ${key.padEnd(12)} "${name.substring(0, 50)}" — would grant: ${missing.map((o) => `${o.key}:${o.target}`).join(", ")}`);
    return;
  }

  let spaceOk = true;
  const grantedOps = [];
  const failedOps = [];
  for (const op of missing) {
    try {
      await c.grantSpacePermission(key, accountId, op.key, op.target);
      stats.opsGranted++;
      grantedOps.push(`${op.key}:${op.target}`);
    } catch (e) {
      // Some errors are benign (e.g. permission already exists returns 400 with specific msg)
      const msg = (e.body && typeof e.body === "object") ? JSON.stringify(e.body) : e.message;
      const benign = /already exist/i.test(msg) || e.statusCode === 409;
      if (benign) {
        stats.opsSkipped++;
        continue;
      }
      stats.opsFailed++;
      spaceOk = false;
      failedOps.push(`${op.key}:${op.target}`);
      failures.push({ spaceKey: key, spaceId: id, op: `${op.key}:${op.target}`, error: msg.substring(0, 300), statusCode: e.statusCode });
    }
  }

  if (spaceOk) stats.granted++;
  else stats.failed++;

  const summary = grantedOps.length > 0
    ? `granted ${grantedOps.length}/${missing.length}`
    : `all missing ops failed`;
  log(`  [${ordinal}/${total}] ${spaceOk ? "OK  " : "FAIL"} ${key.padEnd(12)} "${name.substring(0, 50)}" type=${type || "?"} — ${summary}${failedOps.length ? ` | failed: ${failedOps.join(", ")}` : ""}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
