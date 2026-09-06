/**
 * Diagnostic script — check specific content IDs for existence and restrictions.
 * Usage: node check_pages.js <id1,id2,id3,...>
 */

require("dotenv").config();
const axios = require("axios");

const BASE_URL = process.env.CONFLUENCE_DC_BASE_URL;
const USERNAME = process.env.CONFLUENCE_DC_USERNAME;
const PASSWORD = process.env.CONFLUENCE_DC_PASSWORD;
// Optional: pre-base64-encoded "username:password" (or "username:PAT")
const PRE_ENCODED_AUTH = process.env.CONFLUENCE_DC_BASIC_AUTH;

if (!BASE_URL) {
  console.error("ERROR: Missing CONFLUENCE_DC_BASE_URL in .env");
  process.exit(1);
}
if (!PRE_ENCODED_AUTH && (!USERNAME || !PASSWORD)) {
  console.error(
    "ERROR: Provide either CONFLUENCE_DC_BASIC_AUTH (pre-base64-encoded) " +
      "or both CONFLUENCE_DC_USERNAME and CONFLUENCE_DC_PASSWORD in .env"
  );
  process.exit(1);
}

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

const contentIds = (process.argv[2] || "").split(",").map((s) => s.trim()).filter(Boolean);

if (contentIds.length === 0) {
  console.error("Usage: node check_pages.js <id1,id2,id3,...>");
  process.exit(1);
}

async function checkPage(id) {
  const result = { id, exists: false, title: null, type: null, space: null, status: null, restrictions: null };

  // 1. Check if page exists
  try {
    const res = await client.get(`/rest/api/content/${id}`, {
      params: { expand: "space,version" },
    });
    result.exists = true;
    result.title = res.data.title;
    result.type = res.data.type;
    result.space = res.data.space?.key;
    result.status = res.data.status;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      result.exists = false;
      result.error = "NOT FOUND (404)";
    } else if (status === 403) {
      result.exists = true;
      result.error = "FORBIDDEN (403) — page exists but no view access";
    } else {
      result.error = `HTTP ${status}`;
    }
    return result;
  }

  // 2. Check restrictions
  try {
    const res = await client.get(`/rest/api/content/${id}/restriction/byOperation`);
    const data = res.data;
    const restrictions = {};

    for (const op of ["read", "update"]) {
      const opData = data[op] || data?.results?.find((r) => r.operation === op);
      if (!opData) continue;

      const users = opData.restrictions?.user?.results || [];
      const groups = opData.restrictions?.group?.results || [];

      if (users.length > 0 || groups.length > 0) {
        restrictions[op] = {
          users: users.map((u) => u.username || u.userName || u.displayName),
          groups: groups.map((g) => g.name),
        };
      }
    }

    result.restrictions = Object.keys(restrictions).length > 0 ? restrictions : "NONE";
  } catch (err) {
    result.restrictions = `ERROR: ${err.response?.status}`;
  }

  return result;
}

async function main() {
  console.log(`Checking ${contentIds.length} content IDs against ${BASE_URL}\n`);

  const found = [];
  const notFound = [];
  const restricted = [];

  for (const id of contentIds) {
    const result = await checkPage(id);

    if (!result.exists && !result.error?.includes("FORBIDDEN")) {
      notFound.push(result);
      console.log(`  ${id}: NOT FOUND`);
    } else {
      found.push(result);
      const hasRestrictions = result.restrictions && result.restrictions !== "NONE";
      if (hasRestrictions) restricted.push(result);

      console.log(
        `  ${id}: ${result.title || "(no access)"} | space=${result.space || "?"} | type=${result.type || "?"} | status=${result.status || "?"} | restrictions=${hasRestrictions ? JSON.stringify(result.restrictions) : "NONE"}`
      );
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total checked:  ${contentIds.length}`);
  console.log(`Found:          ${found.length}`);
  console.log(`Not found:      ${notFound.length}`);
  console.log(`Restricted:     ${restricted.length}`);

  if (notFound.length > 0) {
    console.log(`\nNot found IDs: ${notFound.map((r) => r.id).join(",")}`);
  }
  if (restricted.length > 0) {
    console.log(`\nRestricted IDs: ${restricted.map((r) => r.id).join(",")}`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
