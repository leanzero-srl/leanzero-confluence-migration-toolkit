#!/usr/bin/env node

/**
 * export_active_users_dc.js
 *
 * Exports active (licensed) users from a Confluence Data Center instance to CSV.
 * Columns: username, email, displayName.
 *
 * Approach (verified via Atlassian docs + community; no single DC endpoint lists users):
 *   1. Enumerate /rest/api/group/{name}/member?start=N&limit=200 for each
 *      license-granting group (default: confluence-users, confluence-licensed-users).
 *   2. Dedupe by userKey.
 *   3. For each user, GET /rest/api/user?key=<key>&expand=details.personal,status
 *      to retrieve email + active flag (deactivated users remain in the group
 *      but are flagged active=false — see CONFSERVER-95653).
 *   4. Keep only active=true users; write CSV.
 *
 * USAGE
 *   node main/export_active_users_dc.js
 *   node main/export_active_users_dc.js --out path/to/users.csv
 *   node main/export_active_users_dc.js --groups confluence-users --dry-run
 *
 * Required .env (at script root):
 *   DC_BASE_URL=https://confluence.your-company.com    (NO trailing /wiki)
 *   DC_PAT=<personal-access-token>                     (preferred)
 *   --or--
 *   DC_USERNAME=<username>
 *   DC_PASSWORD=<password>
 */

"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { DcClient, run } = require("../src/dcUserExporter");

function parseArgs(argv) {
  const o = {
    out: null,
    groups: "confluence-licensed-users",
    pageSize: 200,
    concurrency: 5,
    dryRun: false,
    filterNeverLoggedIn: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out": o.out = argv[++i]; break;
      case "--groups": o.groups = argv[++i]; break;
      case "--page-size": o.pageSize = parseInt(argv[++i], 10); break;
      case "--concurrency": o.concurrency = parseInt(argv[++i], 10); break;
      case "--dry-run": o.dryRun = true; break;
      case "--filter-never-logged-in": o.filterNeverLoggedIn = true; break;
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
Usage: node main/export_active_users_dc.js [options]

  --out PATH         Output CSV path (default: ./active_users_<timestamp>.csv)
  --groups CSV       Comma-separated group names to enumerate
                     (default: confluence-users,confluence-licensed-users)
  --page-size N      Group-member page size (default: 200, max recommended: 200)
  --concurrency N    Parallel /rest/api/user lookups (default: 5)
  --dry-run          Skip CSV write; just report counts
  --filter-never-logged-in
                     Also exclude users who have never logged in (heuristic:
                     default avatar AND no authored/edited content).
  --help, -h         Show this help

Env (.env at script root):
  DC_BASE_URL    e.g. https://confluence.example.com
  DC_PAT         Personal Access Token (preferred)
    OR
  DC_USERNAME + DC_PASSWORD
`);
}

function makeLogger(logPath) {
  const stream = logPath ? fs.createWriteStream(logPath, { flags: "a" }) : null;
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}`;
    console.log(line);
    if (stream) stream.write(line + "\n");
  };
  return {
    info: (m) => write("INFO ", m),
    warn: (m) => write("WARN ", m),
    error: (m) => write("ERROR", m),
    close: () => stream && stream.end(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return 0; }

  const baseUrl = process.env.DC_BASE_URL;
  if (!baseUrl) {
    console.error("ERROR: DC_BASE_URL not set in .env");
    return 2;
  }
  let auth;
  if (process.env.DC_PAT) {
    auth = { mode: "bearer", token: process.env.DC_PAT };
  } else if (process.env.DC_USERNAME && process.env.DC_PASSWORD) {
    auth = { mode: "basic", username: process.env.DC_USERNAME, password: process.env.DC_PASSWORD };
  } else {
    console.error("ERROR: set DC_PAT (preferred) or DC_USERNAME + DC_PASSWORD in .env");
    return 2;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out || path.resolve(process.cwd(), `active_users_${timestamp}.csv`);

  const logsDir = path.resolve(__dirname, "../logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `export_users_${timestamp}.log`);
  const logger = makeLogger(logPath);

  logger.info(`base=${baseUrl} authMode=${auth.mode} groups=[${args.groups}] pageSize=${args.pageSize} concurrency=${args.concurrency} dryRun=${args.dryRun}`);

  const client = new DcClient(baseUrl, auth);
  const groups = args.groups.split(",").map((s) => s.trim()).filter(Boolean);

  let stats;
  try {
    stats = await run({
      client,
      groups,
      pageSize: args.pageSize,
      concurrency: args.concurrency,
      outPath,
      dryRun: args.dryRun,
      filterNeverLoggedIn: args.filterNeverLoggedIn,
      logger,
    });
  } catch (e) {
    logger.error(`run failed: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    logger.close();
    return 1;
  }

  logger.info("─── summary ────────────────────────────");
  logger.info(`total unique members: ${stats.totalSeen}`);
  logger.info(`active users:         ${stats.active}`);
  logger.info(`inactive users:       ${stats.inactive}`);
  if (stats.everLoggedIn != null) {
    logger.info(`ever logged in:       ${stats.everLoggedIn}`);
    logger.info(`never logged in:      ${stats.neverLoggedIn} (dropped)`);
  }
  logger.info(`fetch errors:         ${stats.fetchErrors}`);
  if (!args.dryRun) logger.info(`CSV:                  ${outPath}`);
  logger.info(`log:                  ${logPath}`);
  logger.close();
  return 0;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
