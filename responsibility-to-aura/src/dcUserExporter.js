"use strict";

const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ─── HTTP client (DC: Bearer PAT or Basic auth) ──────────────────────
// Lifted from dc/probe_dc.js so this script stays self-contained.

class DcClient {
  constructor(baseUrl, auth) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
    this.protocol = parsed.protocol;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    if (auth.mode === "bearer") {
      this.authHeader = "Bearer " + auth.token;
      this.authMode = "bearer";
    } else {
      this.authHeader = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      this.authMode = "basic";
    }
  }

  request(method, relPath) {
    return new Promise((resolve) => {
      const fullPath = this.basePath + relPath;
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: fullPath,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
        timeout: 20000,
      };
      const lib = this.protocol === "https:" ? https : http;
      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          let parseError = null;
          if (data && (res.headers["content-type"] || "").includes("application/json")) {
            try { parsed = JSON.parse(data); } catch (e) { parseError = e.message; }
          }
          resolve({
            url: `${this.baseUrl}${relPath}`,
            method,
            status: res.statusCode,
            json: parsed,
            bodyExcerpt: data.length > 1000 ? data.substring(0, 1000) + "...<truncated>" : data,
            parseError,
          });
        });
      });
      req.on("error", (err) => resolve({ url: `${this.baseUrl}${relPath}`, method, status: 0, error: err.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ url: `${this.baseUrl}${relPath}`, method, status: 0, error: "timeout" });
      });
      req.end();
    });
  }
}

// ─── Group member enumeration ────────────────────────────────────────

async function enumerateGroupMembers(client, groupName, pageSize, logger) {
  const out = [];
  const seen = new Set();
  let start = 0;
  for (;;) {
    const path = `/rest/api/group/${encodeURIComponent(groupName)}/member?start=${start}&limit=${pageSize}`;
    const res = await client.request("GET", path);
    if (res.status === 404) {
      logger.warn(`group "${groupName}": 404 — skipping (group not present on this instance)`);
      return out;
    }
    if (res.status < 200 || res.status >= 300 || !res.json) {
      throw new Error(`group "${groupName}" page start=${start} failed: status=${res.status} ${res.error || ""} body=${res.bodyExcerpt || ""}`);
    }
    const results = Array.isArray(res.json.results) ? res.json.results : [];
    for (const m of results) {
      // DC group/member returns userKey + username + displayName at top level.
      const userKey = m.userKey || (m.user && m.user.userKey) || null;
      const username = m.username || (m.user && m.user.username) || null;
      const displayName = m.displayName || (m.user && m.user.displayName) || null;
      const id = userKey || username;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ userKey, username, displayName });
    }
    logger.info(`group "${groupName}": fetched start=${start} size=${results.length} (cumulative=${out.length})`);
    const limit = res.json.limit || pageSize;
    if (results.length < limit) break;
    start += limit;
    if (start > 1_000_000) {
      throw new Error(`group "${groupName}": pagination safety stop at start=${start}`);
    }
  }
  return out;
}

// ─── Per-user detail fetch ───────────────────────────────────────────

async function fetchUserDetails(client, member) {
  // Two parallel calls on this DC version:
  //  - /rest/api/user?key=...&expand=status  → reliable active flag via `status` ("current" vs "deactivated")
  //  - /rest/mobile/1.0/profile/{username}    → only place email is exposed on this instance
  // (The standard expand=details.personal is silently dropped here, and `active` boolean is absent.)
  const userQuery = member.userKey
    ? `key=${encodeURIComponent(member.userKey)}`
    : `username=${encodeURIComponent(member.username || "")}`;
  const userPath = `/rest/api/user?${userQuery}&expand=status`;
  const profilePath = member.username
    ? `/rest/mobile/1.0/profile/${encodeURIComponent(member.username)}`
    : null;

  const [userRes, profileRes] = await Promise.all([
    client.request("GET", userPath),
    profilePath ? client.request("GET", profilePath) : Promise.resolve(null),
  ]);

  const out = {
    userKey: member.userKey,
    username: member.username,
    displayName: member.displayName,
    email: null,
    active: null,
  };

  if (userRes.status >= 200 && userRes.status < 300 && userRes.json) {
    const j = userRes.json;
    out.userKey = j.userKey || out.userKey;
    out.username = j.username || out.username;
    out.displayName = j.displayName || out.displayName;
    // On this DC: status === "current" means active. Anything else ("deactivated", "deleted", ...) means inactive.
    if (typeof j.active === "boolean") out.active = j.active;
    else if (typeof j.status === "string") out.active = j.status === "current";
    // Custom (non-default) avatar is a strong signal the user logged in at least once to set it.
    out.hasCustomAvatar = !!(j.profilePicture && j.profilePicture.isDefault === false);
  } else {
    out.fetchError = `user-endpoint status=${userRes.status} ${userRes.error || ""}`.trim();
  }

  if (profileRes && profileRes.status >= 200 && profileRes.status < 300 && profileRes.json) {
    out.email = profileRes.json.email || null;
    if (!out.displayName && profileRes.json.fullName) out.displayName = profileRes.json.fullName;
  } else if (profileRes && (profileRes.status < 200 || profileRes.status >= 300)) {
    // Don't blow up on profile failures; just leave email blank.
    out.profileError = `profile-endpoint status=${profileRes.status} ${profileRes.error || ""}`.trim();
  }

  return out;
}

// ─── Activity probe (proxy for "ever logged in") ─────────────────────

async function hasAnyAuthoredContent(client, username) {
  // CQL: did this user create or edit anything? limit=1 — we just need presence.
  const cql = `creator = "${username.replace(/"/g, '\\"')}" OR contributor = "${username.replace(/"/g, '\\"')}"`;
  const path = `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=1`;
  const res = await client.request("GET", path);
  if (!res.json) return { ok: false, hasContent: false, status: res.status };
  const size = typeof res.json.size === "number" ? res.json.size : (res.json.results ? res.json.results.length : 0);
  return { ok: res.status >= 200 && res.status < 300, hasContent: size > 0, status: res.status };
}

// ─── Concurrency pool ────────────────────────────────────────────────

async function pooledMap(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let i = 0;
  let done = 0;
  async function pull() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.max(1, concurrency); w++) workers.push(pull());
  await Promise.all(workers);
  return results;
}

// ─── CSV writer ──────────────────────────────────────────────────────

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(outPath, rows) {
  const header = "username,email,displayName\n";
  const body = rows
    .map((r) => [csvEscape(r.username), csvEscape(r.email), csvEscape(r.displayName)].join(","))
    .join("\n");
  fs.writeFileSync(outPath, header + body + (body ? "\n" : ""), "utf8");
}

// ─── Orchestrator ────────────────────────────────────────────────────

async function run({ client, groups, pageSize, concurrency, outPath, dryRun, logger, filterNeverLoggedIn }) {
  const memberMap = new Map();
  for (const g of groups) {
    const members = await enumerateGroupMembers(client, g, pageSize, logger);
    for (const m of members) {
      const id = m.userKey || m.username;
      if (!id) continue;
      if (!memberMap.has(id)) memberMap.set(id, m);
    }
  }
  const deduped = Array.from(memberMap.values());
  const totalSeen = deduped.length;
  logger.info(`enumerated ${totalSeen} unique members across [${groups.join(", ")}]`);

  let progressTick = 0;
  const details = await pooledMap(deduped, concurrency, (m) => fetchUserDetails(client, m), (done, total) => {
    if (done - progressTick >= 50 || done === total) {
      progressTick = done;
      logger.info(`user-details progress: ${done}/${total}`);
    }
  });

  const fetchErrors = details.filter((d) => d.fetchError);
  const activeUsers = details.filter((d) => d.active === true);
  const inactiveCount = details.filter((d) => d.active === false).length;

  if (fetchErrors.length) {
    logger.warn(`${fetchErrors.length} user-detail fetch errors (first 5):`);
    for (const e of fetchErrors.slice(0, 5)) {
      logger.warn(`  ${e.username || e.userKey}: ${e.fetchError}`);
    }
  }

  let everLoggedInCount = activeUsers.length;
  let neverLoggedInCount = 0;
  let finalUsers = activeUsers;

  if (filterNeverLoggedIn) {
    // Two-tier filter for "ever logged in":
    //   1. Custom (non-default) avatar → must have logged in at least once to upload it → keep.
    //   2. Default avatar → fall back to a CQL "has authored or edited anything?" probe.
    const customAvatar = activeUsers.filter((u) => u.hasCustomAvatar);
    const needsCqlCheck = activeUsers.filter((u) => !u.hasCustomAvatar);
    logger.info(`activity check: ${customAvatar.length} have custom avatar (auto-keep), ${needsCqlCheck.length} need CQL probe`);

    let cqlTick = 0;
    const cqlResults = await pooledMap(needsCqlCheck, concurrency, async (u) => {
      const r = await hasAnyAuthoredContent(client, u.username);
      return { user: u, ...r };
    }, (done, total) => {
      if (done - cqlTick >= 50 || done === total) {
        cqlTick = done;
        logger.info(`cql-probe progress: ${done}/${total}`);
      }
    });

    const cqlKept = cqlResults.filter((r) => r.hasContent).map((r) => r.user);
    const cqlDropped = cqlResults.filter((r) => r.ok && !r.hasContent).map((r) => r.user);
    const cqlErrors = cqlResults.filter((r) => !r.ok);

    if (cqlErrors.length) {
      logger.warn(`${cqlErrors.length} CQL probe errors — treating those users as 'ever logged in' (conservative keep).`);
      // Conservative: if we couldn't tell, don't drop them.
      for (const e of cqlErrors) cqlKept.push(e.user);
    }

    finalUsers = [...customAvatar, ...cqlKept];
    everLoggedInCount = finalUsers.length;
    neverLoggedInCount = cqlDropped.length;
    logger.info(`ever-logged-in: kept=${everLoggedInCount} (custom-avatar=${customAvatar.length} + cql-positive=${cqlKept.length - cqlErrors.length} + cql-error-conservative-keep=${cqlErrors.length}); dropped=${neverLoggedInCount}`);
  }

  if (!dryRun) {
    finalUsers.sort((a, b) => (a.username || "").localeCompare(b.username || ""));
    writeCsv(outPath, finalUsers);
    logger.info(`wrote ${finalUsers.length} rows to ${outPath}`);
  } else {
    logger.info(`[dry-run] would write ${finalUsers.length} rows to ${outPath}`);
  }

  return {
    totalSeen,
    deduped: totalSeen,
    active: activeUsers.length,
    inactive: inactiveCount,
    everLoggedIn: filterNeverLoggedIn ? everLoggedInCount : null,
    neverLoggedIn: filterNeverLoggedIn ? neverLoggedInCount : null,
    fetchErrors: fetchErrors.length,
  };
}

module.exports = {
  DcClient,
  enumerateGroupMembers,
  fetchUserDetails,
  writeCsv,
  run,
};
