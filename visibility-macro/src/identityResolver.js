const fs = require("fs");
const path = require("path");

/**
 * Resolves DC group names → Cloud groupId, and DC usernames → Cloud accountId.
 *
 * Strategy:
 *   - Groups: GET /rest/api/group/by-name?name=...
 *   - Users:  optional CSV mapping (DC username,accountId) preferred; CQL search fallback.
 *
 * Caches:
 *   - In-memory for the run.
 *   - Persists to logs/group_id_cache.json and logs/user_id_cache.json across runs.
 *   - Negative cache entries (resolved to null) are also persisted to avoid repeat lookups.
 */
class IdentityResolver {
  constructor(cloudClient, options = {}) {
    this.cloudClient = cloudClient;
    this.cacheDir = options.cacheDir;
    this.log = options.log || console.log;

    this.groupCachePath = this.cacheDir
      ? path.join(this.cacheDir, "group_id_cache.json")
      : null;
    this.userCachePath = this.cacheDir
      ? path.join(this.cacheDir, "user_id_cache.json")
      : null;

    this.groupCache = this._loadCache(this.groupCachePath);
    this.userCache = this._loadCache(this.userCachePath);

    this.userMappingPath = options.userMappingPath || null;
    this.groupMappingPath = options.groupMappingPath || null;

    this.userMapping = this.userMappingPath
      ? this._loadCsvMapping(this.userMappingPath)
      : new Map();
    this.groupMapping = this.groupMappingPath
      ? this._loadCsvMapping(this.groupMappingPath)
      : new Map();

    if (this.userMapping.size > 0) {
      this.log(`  [Resolver] Loaded ${this.userMapping.size} entries from user mapping CSV`);
    }
    if (this.groupMapping.size > 0) {
      this.log(`  [Resolver] Loaded ${this.groupMapping.size} entries from group mapping CSV`);
    }

    this.stats = {
      groupHits: 0,
      groupMisses: 0,
      userHits: 0,
      userMisses: 0,
      apiLookups: 0,
    };
  }

  _loadCache(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return new Map();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return new Map(Object.entries(data));
    } catch (e) {
      this.log(`  [Resolver] Could not read cache ${filePath}: ${e.message}`);
      return new Map();
    }
  }

  _persistCache(cache, filePath) {
    if (!filePath || !cache) return;
    try {
      const obj = Object.fromEntries(cache);
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      this.log(`  [Resolver] Could not persist cache ${filePath}: ${e.message}`);
    }
  }

  _loadCsvMapping(filePath) {
    const map = new Map();
    if (!fs.existsSync(filePath)) {
      this.log(`  [Resolver] WARNING: Mapping file not found: ${filePath}`);
      return map;
    }
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(",");
        if (parts.length < 2) continue;
        const key = parts[0].trim();
        const value = parts[1].trim();
        if (!key || !value) continue;
        // Skip CSV header
        if (key.toLowerCase() === "username" || key.toLowerCase() === "groupname" || key.toLowerCase() === "name") continue;
        map.set(key.toLowerCase(), value);
      }
    } catch (e) {
      this.log(`  [Resolver] Could not load mapping ${filePath}: ${e.message}`);
    }
    return map;
  }

  /**
   * Resolve a group name to a Cloud groupId. Returns string id or null.
   */
  async resolveGroup(name) {
    if (!name) return null;
    const key = name.toLowerCase();

    // CSV mapping override
    if (this.groupMapping.has(key)) {
      this.stats.groupHits++;
      return this.groupMapping.get(key);
    }

    if (this.groupCache.has(key)) {
      this.stats.groupHits++;
      return this.groupCache.get(key);
    }

    this.stats.apiLookups++;
    let id = null;
    try {
      const group = await this.cloudClient.getGroupByName(name);
      id = group ? group.id : null;
    } catch (e) {
      this.log(`  [Resolver] Group lookup error for "${name}": ${e.message}`);
    }

    this.groupCache.set(key, id);
    this._persistCache(this.groupCache, this.groupCachePath);

    if (id) this.stats.groupHits++;
    else this.stats.groupMisses++;
    return id;
  }

  /**
   * Resolve a username to a Cloud accountId. Returns string accountId or null.
   */
  async resolveUser(name) {
    if (!name) return null;
    const key = name.toLowerCase();

    if (this.userMapping.has(key)) {
      this.stats.userHits++;
      return this.userMapping.get(key);
    }

    if (this.userCache.has(key)) {
      this.stats.userHits++;
      return this.userCache.get(key);
    }

    this.stats.apiLookups++;
    let accountId = null;
    try {
      const users = await this.cloudClient.searchUsers(name, 5);
      // Prefer exact match on publicName/username/displayName
      const exact = users.find(
        (u) =>
          (u.publicName && u.publicName.toLowerCase() === key) ||
          (u.username && u.username.toLowerCase() === key) ||
          (u.displayName && u.displayName.toLowerCase() === key) ||
          (u.email && u.email.toLowerCase() === key),
      );
      const candidate = exact || (users.length === 1 ? users[0] : null);
      if (candidate) {
        accountId = candidate.accountId;
      } else if (users.length > 1) {
        this.log(`  [Resolver] WARNING: Ambiguous user lookup for "${name}" (${users.length} candidates), skipping`);
      }
    } catch (e) {
      this.log(`  [Resolver] User lookup error for "${name}": ${e.message}`);
    }

    this.userCache.set(key, accountId);
    this._persistCache(this.userCache, this.userCachePath);

    if (accountId) this.stats.userHits++;
    else this.stats.userMisses++;
    return accountId;
  }

  /**
   * Resolve a comma-separated list of names. Returns {ids: string, unresolved: string[]}.
   *   - ids: comma-separated joined IDs of resolved entries (in original order)
   *   - unresolved: names that could not be resolved
   */
  async resolveList(commaSeparated, kind /* "user"|"group" */) {
    const result = { ids: "", unresolved: [] };
    if (!commaSeparated) return result;

    const names = commaSeparated.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return result;

    const resolved = [];
    for (const name of names) {
      const id =
        kind === "group" ? await this.resolveGroup(name) : await this.resolveUser(name);
      if (id) resolved.push(id);
      else result.unresolved.push(name);
    }
    result.ids = resolved.join(",");
    return result;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = IdentityResolver;
