/**
 * Scaffold Migration Fix - Backup & remove all page-level restrictions
 * from Confluence DC so Scaffold migration can proceed.
 *
 * Scans all spaces for restricted pages/blogposts, saves a full backup
 * of all restrictions to a JSON file, then removes the restrictions.
 *
 * After migration completes, use restore_restrictions_cloud.js to re-apply
 * the restrictions on the Cloud instance using the backup JSON.
 *
 * Error message this fixes:
 *   "Some data are still not migrated. If these space(s) contain restricted pages,
 *    please run the migration script provided."
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your credentials
 *   2. npm install
 *   3. node remove_restrictions_dc.js --dry-run          (preview first)
 *   4. node remove_restrictions_dc.js                    (execute)
 *   5. Re-run the Scaffold migration from the Cloud migration assistant
 *   6. After migration, run: node restore_restrictions_cloud.js --backup backups/<file>.json
 *
 * Run with --help for all options.
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ── CLI Argument Parsing ─────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: node remove_restrictions_dc.js [options]

Options:
  --concurrency <n>      Concurrent API requests (default: 5, max: 5)
  --space-keys <K1,K2>   Filter to specific space keys (comma-separated)
  --space-type <type>    Space type to scan: global, personal, all (default: all)
  --content-type <type>  Content type to scan: page, blogpost, all (default: all)
  --dry-run              Preview mode — backup restrictions but do not remove them
  --help                 Show this help message

Environment variables (.env):
  CONFLUENCE_DC_BASE_URL   Confluence DC instance URL
  CONFLUENCE_DC_USERNAME   Admin username (ignored if CONFLUENCE_DC_BASIC_AUTH is set)
  CONFLUENCE_DC_PASSWORD   Admin password (ignored if CONFLUENCE_DC_BASIC_AUTH is set)
  CONFLUENCE_DC_BASIC_AUTH Optional pre-base64-encoded "username:password" or
                           "username:PAT"; when set, takes precedence over
                           CONFLUENCE_DC_USERNAME / CONFLUENCE_DC_PASSWORD.
  DRY_RUN                  Set to "true" for preview mode (--dry-run overrides)
  SPACE_KEYS               Comma-separated space keys (--space-keys overrides)
`);
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    concurrency: 5,
    spaceKeys: null,
    spaceType: "all",
    contentType: "all",
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        printHelp();
        break;
      case "--concurrency":
        options.concurrency = Math.min(parseInt(args[++i], 10) || 5, 5);
        break;
      case "--space-keys":
        options.spaceKeys = args[++i];
        break;
      case "--space-type":
        options.spaceType = args[++i] || "all";
        if (!["global", "personal", "all"].includes(options.spaceType)) {
          console.error(`ERROR: Invalid --space-type "${options.spaceType}". Must be: global, personal, all`);
          process.exit(1);
        }
        break;
      case "--content-type":
        options.contentType = args[++i] || "all";
        if (!["page", "blogpost", "all"].includes(options.contentType)) {
          console.error(`ERROR: Invalid --content-type "${options.contentType}". Must be: page, blogpost, all`);
          process.exit(1);
        }
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        console.error(`ERROR: Unknown option "${args[i]}". Run with --help for usage.`);
        process.exit(1);
    }
  }

  return options;
}

const options = parseArgs();

// ── Configuration ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.CONFLUENCE_DC_BASE_URL;
const USERNAME = process.env.CONFLUENCE_DC_USERNAME;
const PASSWORD = process.env.CONFLUENCE_DC_PASSWORD;
// Optional: pre-base64-encoded "username:password" (or "username:PAT").
// When set, this takes precedence over CONFLUENCE_DC_USERNAME / CONFLUENCE_DC_PASSWORD.
const PRE_ENCODED_AUTH = process.env.CONFLUENCE_DC_BASIC_AUTH;
const DRY_RUN = options.dryRun || process.env.DRY_RUN === "true";
const CONCURRENCY = options.concurrency;
const SPACE_TYPE = options.spaceType;
const CONTENT_TYPES = options.contentType === "all" ? ["page", "blogpost"] : [options.contentType];

if (!BASE_URL) {
  console.error(
    "ERROR: Missing CONFLUENCE_DC_BASE_URL. Copy .env.example to .env and fill in the values."
  );
  process.exit(1);
}
if (!PRE_ENCODED_AUTH && (!USERNAME || !PASSWORD)) {
  console.error(
    "ERROR: Provide either CONFLUENCE_DC_BASIC_AUTH (pre-base64-encoded) " +
      "or both CONFLUENCE_DC_USERNAME and CONFLUENCE_DC_PASSWORD in .env."
  );
  process.exit(1);
}

// ── Output Directories ────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, "logs");
const BACKUP_DIR = path.join(__dirname, "backups");
for (const dir of [LOG_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Logging ────────────────────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(LOG_DIR, `scaffold-fix-${timestamp}.log`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── HTTP Client ────────────────────────────────────────────────────────────────

const authHeader =
  "Basic " +
  (PRE_ENCODED_AUTH
    ? PRE_ENCODED_AUTH.trim()
    : Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64"));

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

async function requestWithRetry(config, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.request(config);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        const retryAfter = err.response?.headers?.["retry-after"];
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(2000 * Math.pow(2, attempt), 30000);
        log(
          "WARN",
          `Request failed with ${status}, retrying in ${delay}ms (attempt ${attempt}/${retries})`
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Concurrency Helper ───────────────────────────────────────────────────────

async function runWithConcurrency(items, concurrency, fn) {
  let idx = 0;
  const results = [];
  results.length = items.length;
  const worker = async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

// ── API Functions ──────────────────────────────────────────────────────────────

async function getAllSpaces() {
  const spaces = [];
  let start = 0;
  const limit = 100;

  log("INFO", `Fetching spaces (type: ${SPACE_TYPE})...`);

  const params = { start, limit };
  if (SPACE_TYPE !== "all") {
    params.type = SPACE_TYPE;
  }

  while (true) {
    const reqParams = { ...params, start };
    const res = await requestWithRetry({
      method: "GET",
      url: `/rest/api/space`,
      params: reqParams,
    });

    const results = res.data.results || [];
    spaces.push(...results);

    log(
      "INFO",
      `Fetched ${results.length} spaces (total so far: ${spaces.length})`
    );

    if (results.length < limit || !res.data._links?.next) {
      break;
    }
    start += limit;
  }

  log("INFO", `Total spaces found: ${spaces.length}`);
  return spaces;
}

/**
 * Fetch all content in a space, then check each item's restrictions via
 * the dedicated restriction endpoint (more reliable than CQL expand).
 */
async function getRestrictedContentInSpace(spaceKey) {
  // Step 1: Enumerate ALL content in the space via direct content endpoint
  // (CQL search is permission-filtered and hides view-restricted pages)
  const allContent = [];

  for (const type of CONTENT_TYPES) {
    let start = 0;
    const limit = 50;

    while (true) {
      let res;
      try {
        res = await requestWithRetry({
          method: "GET",
          url: `/rest/api/content`,
          params: { spaceKey, type, start, limit, status: "current", depth: "all" },
        });
      } catch (err) {
        const status = err.response?.status;
        log(
          "WARN",
          `  Failed to list ${type}s in space ${spaceKey} (start=${start}): ${status}`
        );
        break;
      }

      const results = res.data.results || [];
      allContent.push(
        ...results.map((c) => ({ id: c.id, title: c.title, type: c.type }))
      );

      if (!res.data._links?.next) {
        break;
      }
      start += limit;
    }
  }

  if (allContent.length === 0) return [];

  log("INFO", `  Found ${allContent.length} content item(s), checking restrictions...`);

  // Step 2: Check each item via the dedicated restriction endpoint (concurrent)
  const restricted = [];
  let checked = 0;

  await runWithConcurrency(allContent, CONCURRENCY, async (content) => {
    const current = ++checked;
    if (current % 100 === 0 || current === 1) {
      log("INFO", `  Checking restrictions... ${current}/${allContent.length}`);
    }

    let restrictionData;
    try {
      const res = await requestWithRetry({
        method: "GET",
        url: `/rest/api/content/${content.id}/restriction/byOperation`,
      });
      restrictionData = res.data;
    } catch (err) {
      log(
        "WARN",
        `  Failed to get restrictions for ${content.title} (${content.id}): ${err.response?.status}`
      );
      return;
    }

    // restrictionData is an object keyed by operation (read, update)
    const restrictions = {};
    let hasRestrictions = false;

    for (const op of ["read", "update"]) {
      const opData = restrictionData[op] || restrictionData?.results?.find((r) => r.operation === op);
      if (!opData) continue;

      const users = opData.restrictions?.user?.results || [];
      const groups = opData.restrictions?.group?.results || [];

      if (users.length > 0 || groups.length > 0) {
        hasRestrictions = true;
        restrictions[op] = { restrictions: { user: { results: users }, group: { results: groups } } };
      }
    }

    if (hasRestrictions) {
      restricted.push({
        id: content.id,
        title: content.title,
        type: content.type,
        spaceKey,
        restrictions,
      });
    }
  });

  return restricted;
}

/**
 * Build a clean backup entry from the raw restriction data returned by the API.
 */
function buildBackupEntry(content) {
  const entry = {
    contentId: content.id,
    title: content.title,
    type: content.type,
    spaceKey: content.spaceKey,
    operations: {},
  };

  for (const op of ["read", "update"]) {
    const opData = content.restrictions?.[op];
    if (!opData) continue;

    const users = (opData.restrictions?.user?.results || []).map((u) => ({
      username: u.username || u.userName,
      userKey: u.userKey || null,
      displayName: u.displayName || null,
    }));

    const groups = (opData.restrictions?.group?.results || []).map((g) => ({
      name: g.name,
      id: g.id || null,
    }));

    if (users.length > 0 || groups.length > 0) {
      entry.operations[op] = { users, groups };
    }
  }

  return entry;
}

/**
 * Remove all restrictions from a piece of content.
 * Uses PUT /rest/api/content/{id}/restriction with the exact payload format
 * confirmed working on Confluence DC 8.5.0 via the REST API Browser.
 */
async function removeContentRestrictions(contentId, contentTitle) {
  const payload = {
    results: [
      {
        operation: "read",
        restrictions: {
          user: { results: [] },
          group: { results: [] },
        },
      },
      {
        operation: "update",
        restrictions: {
          user: { results: [] },
          group: { results: [] },
        },
      },
    ],
  };

  try {
    const res = await requestWithRetry({
      method: "PUT",
      url: `/rest/experimental/content/${contentId}/restriction`,
      data: payload,
    });

    if (res.status === 200 || res.status === 204) {
      log("INFO", `    [OK] Restrictions removed from: ${contentTitle} (${contentId})`);
      return { contentId, success: true };
    }

    return { contentId, success: false, error: `Unexpected status ${res.status}` };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message =
      typeof body === "string" ? body : body?.message || JSON.stringify(body);
    log(
      "ERROR",
      `    [FAIL] ${contentTitle} (${contentId}): ${status} - ${message}`
    );
    return { contentId, success: false, error: `${status} - ${message}` };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log("INFO", "=== Scaffold Migration Fix - Remove Restrictions ===");
  log("INFO", `Confluence DC URL: ${BASE_URL}`);
  log("INFO", `Dry run: ${DRY_RUN}`);
  log("INFO", `Concurrency: ${CONCURRENCY}`);
  log("INFO", `Space type: ${SPACE_TYPE}`);
  log("INFO", `Content types: ${CONTENT_TYPES.join(", ")}`);
  log("INFO", "");

  let spaces;
  const spaceKeysFilter = options.spaceKeys || process.env.SPACE_KEYS;
  if (spaceKeysFilter) {
    spaces = spaceKeysFilter.split(",").map((k) => ({ key: k.trim(), name: k.trim() }));
    log("INFO", `Filtering to spaces: ${spaceKeysFilter}`);
  } else {
    spaces = await getAllSpaces();
  }

  if (spaces.length === 0) {
    log("WARN", "No spaces found. Nothing to do.");
    return;
  }

  const backupData = {
    exportedAt: new Date().toISOString(),
    sourceInstance: BASE_URL,
    totalEntries: 0,
    entries: [],
  };

  const results = {
    totalRestricted: 0,
    removed: 0,
    failed: 0,
    failures: [],
  };

  for (let i = 0; i < spaces.length; i++) {
    const space = spaces[i];
    log(
      "INFO",
      `[${i + 1}/${spaces.length}] Scanning space: ${space.key} (${space.name})`
    );

    const restrictedContent = await getRestrictedContentInSpace(space.key);

    if (restrictedContent.length === 0) {
      log("INFO", `  No restricted content in space ${space.key}`);
      continue;
    }

    log(
      "INFO",
      `  Found ${restrictedContent.length} restricted item(s) in space ${space.key}`
    );
    results.totalRestricted += restrictedContent.length;

    // Build backup entries (sequential, no API calls)
    for (const content of restrictedContent) {
      backupData.entries.push(buildBackupEntry(content));
    }

    if (DRY_RUN) {
      for (const content of restrictedContent) {
        const entry = backupData.entries.find((e) => e.contentId === content.id);
        const ops = Object.keys(entry.operations).join(", ");
        log(
          "INFO",
          `    [DRY RUN] Would remove ${ops} restrictions from: ${content.title} (${content.id})`
        );
      }
      continue;
    }

    // Remove restrictions concurrently
    await runWithConcurrency(restrictedContent, CONCURRENCY, async (content) => {
      const result = await removeContentRestrictions(content.id, content.title);

      if (result.success) {
        results.removed++;
      } else {
        results.failed++;
        results.failures.push({
          contentId: content.id,
          title: content.title,
          spaceKey: space.key,
          error: result.error,
        });
      }
    });
  }

  // Save the backup JSON
  backupData.totalEntries = backupData.entries.length;
  const backupFile = path.join(
    BACKUP_DIR,
    `restrictions-backup-${timestamp}.json`
  );
  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), "utf-8");

  // Summary
  log("INFO", "");
  log("INFO", "========================================");
  log("INFO", "  SUMMARY");
  log("INFO", "========================================");
  log("INFO", `Restrictions found: ${results.totalRestricted}`);
  log("INFO", `Removed: ${results.removed}`);
  log("INFO", `Failed: ${results.failed}`);
  log("INFO", `Backup file: ${backupFile}`);
  log("INFO", `Log file: ${logFile}`);

  if (results.failures.length > 0) {
    log("INFO", "");
    log("INFO", "Failures:");
    for (const f of results.failures) {
      log("INFO", `  - [${f.spaceKey}] ${f.title} (${f.contentId}): ${f.error}`);
    }
  }

  if (!DRY_RUN && results.failed === 0) {
    log("INFO", "");
    log("INFO", "All restrictions removed. Next steps:");
    log("INFO", "  1. Re-run the Scaffold migration from the Cloud migration assistant");
    log("INFO", "  2. After migration completes, restore restrictions in Cloud:");
    log("INFO", `     node restore_restrictions_cloud.js --backup ${backupFile}`);
  }
}

main().catch((err) => {
  log("ERROR", `Fatal error: ${err.message}`);
  process.exit(1);
});
