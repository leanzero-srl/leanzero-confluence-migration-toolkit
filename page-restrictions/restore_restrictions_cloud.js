/**
 * Restore page-level restrictions on Confluence Cloud after migration.
 *
 * Reads the backup JSON produced by add_addon_user_permissions.js and re-applies
 * the restrictions on the Cloud instance. Since Cloud uses accountId instead of
 * DC usernames, the script first builds a username -> accountId mapping by querying
 * the Cloud user search API, then applies the restrictions per page.
 *
 * Usage:
 *   node restore_restrictions_cloud.js --backup backups/restrictions-backup-<timestamp>.json
 *
 * Prerequisites:
 *   - Set CONFLUENCE_CLOUD_* variables in .env
 *   - The migration must be complete (pages must exist in Cloud)
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ── Configuration ──────────────────────────────────────────────────────────────

const CLOUD_BASE_URL = process.env.CONFLUENCE_CLOUD_BASE_URL; // e.g. https://company.atlassian.net/wiki
const CLOUD_EMAIL = process.env.CONFLUENCE_CLOUD_EMAIL;
const CLOUD_API_TOKEN = process.env.CONFLUENCE_CLOUD_API_TOKEN;
// Optional: pre-base64-encoded "email:apiToken".
// When set, takes precedence over CONFLUENCE_CLOUD_EMAIL / CONFLUENCE_CLOUD_API_TOKEN.
const PRE_ENCODED_AUTH = process.env.CONFLUENCE_CLOUD_BASIC_AUTH;
const DRY_RUN = process.env.DRY_RUN === "true";

if (!CLOUD_BASE_URL) {
  console.error("ERROR: Missing CONFLUENCE_CLOUD_BASE_URL in .env");
  process.exit(1);
}
if (!PRE_ENCODED_AUTH && (!CLOUD_EMAIL || !CLOUD_API_TOKEN)) {
  console.error(
    "ERROR: Provide either CONFLUENCE_CLOUD_BASIC_AUTH (pre-base64-encoded) " +
      "or both CONFLUENCE_CLOUD_EMAIL and CONFLUENCE_CLOUD_API_TOKEN in .env"
  );
  process.exit(1);
}

// Parse --backup argument
const backupArgIdx = process.argv.indexOf("--backup");
if (backupArgIdx === -1 || !process.argv[backupArgIdx + 1]) {
  console.error("ERROR: Provide the backup file path: --backup <path>");
  process.exit(1);
}

const backupFilePath = path.resolve(process.argv[backupArgIdx + 1]);
if (!fs.existsSync(backupFilePath)) {
  console.error(`ERROR: Backup file not found: ${backupFilePath}`);
  process.exit(1);
}

// ── Logging ────────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(LOG_DIR, `restore-restrictions-${timestamp}.log`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── HTTP Client (Cloud) ────────────────────────────────────────────────────────

const authHeader =
  "Basic " +
  (PRE_ENCODED_AUTH
    ? PRE_ENCODED_AUTH.trim()
    : Buffer.from(`${CLOUD_EMAIL}:${CLOUD_API_TOKEN}`).toString("base64"));

const client = axios.create({
  baseURL: CLOUD_BASE_URL,
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

// ── User Mapping ───────────────────────────────────────────────────────────────

/**
 * Search for a Cloud user by their DC username to get their accountId.
 * The migration preserves usernames as displayNames or makes them searchable.
 * Uses the Confluence Cloud v1 search API: GET /rest/api/search?cql=type=user AND ...
 */
async function findCloudAccountId(dcUsername, dcDisplayName) {
  const searchTerms = [dcUsername];
  if (dcDisplayName && dcDisplayName !== dcUsername) {
    searchTerms.push(dcDisplayName);
  }

  for (const query of searchTerms) {
    try {
      // Cloud v1 general search with user type filter
      const cql = `type=user AND user.fullname~"${query}"`;
      const res = await requestWithRetry({
        method: "GET",
        url: `/rest/api/search`,
        params: { cql, limit: 5 },
      });

      const results = res.data?.results || [];
      if (results.length === 1) {
        return results[0].user?.accountId || null;
      }

      // If multiple results, try exact match on displayName
      if (results.length > 1) {
        const exact = results.find(
          (r) =>
            r.user?.displayName?.toLowerCase() === query.toLowerCase() ||
            r.user?.publicName?.toLowerCase() === query.toLowerCase()
        );
        if (exact) return exact.user.accountId;
      }
    } catch {
      // Search failed, try next strategy
    }
  }

  return null;
}

/**
 * Build a mapping of DC usernames to Cloud accountIds for all users in the backup.
 */
async function buildUserMapping(backupEntries) {
  // Collect unique usernames from all entries
  const usersToResolve = new Map(); // username -> displayName

  for (const entry of backupEntries) {
    for (const op of Object.values(entry.operations)) {
      for (const user of op.users) {
        if (user.username && !usersToResolve.has(user.username)) {
          usersToResolve.set(user.username, user.displayName || null);
        }
      }
    }
  }

  log("INFO", `Resolving ${usersToResolve.size} unique DC usernames to Cloud accountIds...`);

  const mapping = new Map(); // username -> accountId
  const unmapped = [];

  for (const [username, displayName] of usersToResolve) {
    const accountId = await findCloudAccountId(username, displayName);
    if (accountId) {
      mapping.set(username, accountId);
      log("INFO", `  [OK] ${username} -> ${accountId}`);
    } else {
      unmapped.push(username);
      log("WARN", `  [UNMAPPED] ${username} (${displayName || "no display name"})`);
    }
    await sleep(200);
  }

  if (unmapped.length > 0) {
    log("WARN", `${unmapped.length} user(s) could not be mapped. Their restrictions will be skipped.`);
    log("WARN", `Unmapped users: ${unmapped.join(", ")}`);
  }

  return { mapping, unmapped };
}

// ── Restore Restrictions ───────────────────────────────────────────────────────

/**
 * Find the Cloud content ID for a page by its title and space key.
 * After migration, the spaceKey and page title should be preserved.
 */
async function findCloudContentId(spaceKey, title, contentType) {
  const type = contentType === "blogpost" ? "blogpost" : "page";
  const cql = `space="${spaceKey}" AND title="${title.replace(/"/g, '\\"')}" AND type=${type}`;

  try {
    const res = await requestWithRetry({
      method: "GET",
      url: `/rest/api/content/search`,
      params: { cql, limit: 1 },
    });

    const results = res.data?.results || [];
    if (results.length > 0) {
      return results[0].id;
    }
  } catch (err) {
    log("WARN", `  Could not search for content: ${title} in ${spaceKey}`);
  }

  return null;
}

/**
 * Apply restrictions to a Cloud page.
 * Cloud uses the same PUT /rest/api/content/{id}/restriction endpoint
 * but requires accountId for users instead of username.
 */
async function applyRestrictions(cloudContentId, title, operations, userMapping) {
  const payload = [];

  for (const [op, data] of Object.entries(operations)) {
    const users = [];
    const groups = [];

    for (const user of data.users) {
      const accountId = userMapping.get(user.username);
      if (accountId) {
        users.push({ type: "known", accountId });
      }
    }

    for (const group of data.groups) {
      groups.push({ type: "group", name: group.name });
    }

    // Only add restriction if we have at least one user or group to restrict to
    if (users.length > 0 || groups.length > 0) {
      const entry = { operation: op, restrictions: {} };
      if (users.length > 0) entry.restrictions.user = users;
      if (groups.length > 0) entry.restrictions.group = groups;
      payload.push(entry);
    }
  }

  if (payload.length === 0) {
    log(
      "WARN",
      `    [SKIP] No mappable users/groups for: ${title} (${cloudContentId})`
    );
    return { success: true, skipped: true };
  }

  try {
    const res = await requestWithRetry({
      method: "PUT",
      url: `/rest/api/content/${cloudContentId}/restriction`,
      data: payload,
    });

    if (res.status === 200 || res.status === 204) {
      log("INFO", `    [OK] Restrictions restored for: ${title} (${cloudContentId})`);
      return { success: true };
    }

    return { success: false, error: `Unexpected status ${res.status}` };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message =
      typeof body === "string" ? body : body?.message || JSON.stringify(body);
    log(
      "ERROR",
      `    [FAIL] ${title} (${cloudContentId}): ${status} - ${message}`
    );
    return { success: false, error: `${status} - ${message}` };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log("INFO", "=== Restore Restrictions to Confluence Cloud ===");
  log("INFO", `Cloud URL: ${CLOUD_BASE_URL}`);
  log("INFO", `Backup file: ${backupFilePath}`);
  log("INFO", `Dry run: ${DRY_RUN}`);
  log("INFO", "");

  // Load backup
  const backupData = JSON.parse(fs.readFileSync(backupFilePath, "utf-8"));
  log("INFO", `Backup created at: ${backupData.exportedAt}`);
  log("INFO", `Source DC instance: ${backupData.sourceInstance}`);
  log("INFO", `Total entries: ${backupData.totalEntries}`);
  log("INFO", "");

  if (backupData.entries.length === 0) {
    log("INFO", "No restriction entries in backup. Nothing to restore.");
    return;
  }

  // Step 1: Build username -> accountId mapping
  log("INFO", "========================================");
  log("INFO", "  STEP 1: Build user mapping");
  log("INFO", "========================================");
  log("INFO", "");

  const { mapping: userMapping, unmapped } = await buildUserMapping(
    backupData.entries
  );

  log("INFO", "");
  log("INFO", `Mapped: ${userMapping.size} users, Unmapped: ${unmapped.length} users`);

  // Save mapping for reference
  const mappingFile = path.join(
    __dirname,
    "backups",
    `user-mapping-${timestamp}.json`
  );
  const mappingObj = {};
  for (const [k, v] of userMapping) mappingObj[k] = v;
  fs.writeFileSync(
    mappingFile,
    JSON.stringify({ mapped: mappingObj, unmapped }, null, 2),
    "utf-8"
  );
  log("INFO", `User mapping saved to: ${mappingFile}`);

  // Step 2: Restore restrictions
  log("INFO", "");
  log("INFO", "========================================");
  log("INFO", "  STEP 2: Restore restrictions");
  log("INFO", "========================================");
  log("INFO", "");

  const results = {
    restored: 0,
    skipped: 0,
    notFound: 0,
    failed: 0,
    failures: [],
  };

  for (let i = 0; i < backupData.entries.length; i++) {
    const entry = backupData.entries[i];
    log(
      "INFO",
      `[${i + 1}/${backupData.entries.length}] ${entry.spaceKey}: ${entry.title} (DC id: ${entry.contentId})`
    );

    // Find the Cloud content ID by space + title
    const cloudContentId = await findCloudContentId(
      entry.spaceKey,
      entry.title,
      entry.type
    );

    if (!cloudContentId) {
      log(
        "WARN",
        `    [NOT FOUND] Could not find in Cloud: ${entry.spaceKey}/${entry.title}`
      );
      results.notFound++;
      continue;
    }

    if (DRY_RUN) {
      const ops = Object.keys(entry.operations).join(", ");
      log(
        "INFO",
        `    [DRY RUN] Would restore ${ops} restrictions on Cloud id ${cloudContentId}`
      );
      results.skipped++;
      continue;
    }

    const result = await applyRestrictions(
      cloudContentId,
      entry.title,
      entry.operations,
      userMapping
    );

    if (result.success) {
      if (result.skipped) {
        results.skipped++;
      } else {
        results.restored++;
      }
    } else {
      results.failed++;
      results.failures.push({
        spaceKey: entry.spaceKey,
        title: entry.title,
        dcContentId: entry.contentId,
        cloudContentId,
        error: result.error,
      });
    }

    await sleep(200);
  }

  // Summary
  log("INFO", "");
  log("INFO", "========================================");
  log("INFO", "  SUMMARY");
  log("INFO", "========================================");
  log("INFO", `Total entries in backup: ${backupData.entries.length}`);
  log("INFO", `Restored: ${results.restored}`);
  log("INFO", `Skipped (no mappable users or dry run): ${results.skipped}`);
  log("INFO", `Not found in Cloud: ${results.notFound}`);
  log("INFO", `Failed: ${results.failed}`);
  log("INFO", `User mapping file: ${mappingFile}`);
  log("INFO", `Log file: ${logFile}`);

  if (results.failures.length > 0) {
    log("INFO", "");
    log("INFO", "Failures:");
    for (const f of results.failures) {
      log(
        "INFO",
        `  - [${f.spaceKey}] ${f.title} (DC: ${f.dcContentId}, Cloud: ${f.cloudContentId}): ${f.error}`
      );
    }
  }

  if (unmapped.length > 0) {
    log("INFO", "");
    log(
      "WARN",
      `${unmapped.length} DC user(s) could not be mapped to Cloud. Their restrictions were not restored.`
    );
    log(
      "INFO",
      "You may need to manually add these users to the affected pages in Cloud."
    );
  }
}

main().catch((err) => {
  log("ERROR", `Fatal error: ${err.message}`);
  process.exit(1);
});
