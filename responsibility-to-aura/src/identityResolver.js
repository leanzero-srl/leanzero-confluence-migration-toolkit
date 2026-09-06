"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Resolves user tokens found inside Linchpin Responsibility macros to
 * Cloud accountIds.
 *
 * A "token" is one of:
 *   - a 24+ char accountId already (returned as-is, no lookup)
 *   - an email address (looked up via Jira /rest/api/3/user/search?query=<email>)
 *   - a free-text DC username or displayName (looked up via the same endpoint)
 *   - a legacy DC userkey (e.g. "ff8080812abc...") — these usually do NOT
 *     resolve against Jira's search (which indexes displayName/email/accountId),
 *     so the resolver will mark them unresolved unless the optional
 *     userkey CSV mapping supplies them
 *
 * Caches:
 *   - In-memory for the run
 *   - Persists to logs/user_id_cache.json across runs (so a second pass
 *     across the same tenant doesn't re-hit the Jira API)
 *   - Negative cache entries (resolved to null) are also persisted to
 *     avoid retrying the same hopeless lookup over and over
 *
 * Optional overrides via CSV file (--user-mapping users.csv):
 *   token,accountId
 *   alice@example.com,557058:abcd-1234
 *   bob-username,557058:ef01-5678
 *   ff8080812abc1234,557058:9999-aaaa
 *
 * Lookup precedence:
 *   1. CSV mapping (case-insensitive)
 *   2. Persistent on-disk cache
 *   3. Jira API search (one call per unique token, then cached)
 */
class IdentityResolver {
  constructor(cloudClient, options = {}) {
    this.cloudClient = cloudClient;
    this.cacheDir = options.cacheDir;
    this.log = options.log || console.log;

    this.userCachePath = this.cacheDir
      ? path.join(this.cacheDir, "user_id_cache.json")
      : null;
    this.userCache = this._loadCache(this.userCachePath);

    this.userMappingPath = options.userMappingPath || null;
    this.userMapping = this.userMappingPath
      ? this._loadCsvMapping(this.userMappingPath)
      : new Map();

    if (this.userMapping.size > 0) {
      this.log(`  [Resolver] Loaded ${this.userMapping.size} entries from user mapping CSV`);
    }

    this.stats = {
      cacheHits: 0,
      mappingHits: 0,
      apiLookups: 0,
      apiHits: 0,
      apiMisses: 0,
      multiMatched: 0,
      ambiguous: 0,
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

  _persistCache() {
    if (!this.userCachePath || !this.userCache) return;
    try {
      const obj = Object.fromEntries(this.userCache);
      fs.writeFileSync(this.userCachePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      this.log(`  [Resolver] Could not persist cache ${this.userCachePath}: ${e.message}`);
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
        const lower = key.toLowerCase();
        if (lower === "token" || lower === "username" || lower === "name" || lower === "userkey") continue;
        map.set(lower, value);
      }
    } catch (e) {
      this.log(`  [Resolver] Could not load mapping ${filePath}: ${e.message}`);
    }
    return map;
  }

  /**
   * A Cloud accountId looks like "557058:UUID" or a 24+ alphanumeric+:
   * blob. Don't be too strict — if it has a colon and is >20 chars, treat
   * as an accountId and skip the lookup. Worst case Jira returns 404 and
   * the page is logged as unresolved.
   */
  _looksLikeAccountId(token) {
    if (!token || typeof token !== "string") return false;
    if (token.length < 12) return false;
    return token.includes(":") || /^[a-f0-9]{24,}$/i.test(token);
  }

  /**
   * Derive a likely Cloud displayName from an email's local-part.
   * Pattern works for most corporate "firstname.lastname@..."
   * email schemes. Strips the domain, replaces dots/underscores/hyphens
   * with spaces, collapses whitespace.
   *
   *   "Jane.Doe@example.com"  -> "Jane Doe"
   *   "alice_bob@example.com"        -> "alice bob"
   *   "alice"                        -> "alice"
   */
  _deriveDisplayNameFromEmail(token) {
    if (!token) return null;
    const at = token.indexOf("@");
    const local = at === -1 ? token : token.substring(0, at);
    const cleaned = local.replace(/[._\-]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned || null;
  }

  /**
   * Generate displayName query variants for fuzzy matching. Confluence
   * CQL `~` is a single-token Lucene fuzzy with default edit distance 2,
   * which handles single-letter umlauts (e.g. Stutzer → Stützer) but not
   * full German digraphs (Zuercher → Zürcher is edit distance 2 from a
   * 7-char target — at the boundary; in practice misses).
   *
   * Returns the original plus a romanization-collapsed variant where:
   *   ue → u   (Zuercher → Zurcher)
   *   oe → o   (Boehm → Bohm)
   *   ae → a   (Maerz → Marz)
   *   ss → s   (also valid for ß targets)
   *
   * Deduped — caller may pass a name without any digraphs.
   */
  _deriveQueryVariants(displayName) {
    if (!displayName) return [];
    const out = [];
    const add = (v) => { if (v && !out.includes(v)) out.push(v); };
    add(displayName);

    // Variant 1: drop short middle "initials" — tokens of length 1-2 lower-case
    // between others. Catches "John A Roe" → "John Roe".
    const tokens = displayName.split(/\s+/).filter(Boolean);
    if (tokens.length > 2) {
      const trimmed = tokens.filter((t, i) =>
        i === 0 || i === tokens.length - 1 || t.length > 2,
      );
      add(trimmed.join(" "));
    }

    // Variant 2: insert space at every lowerCase→UpperCase boundary, to
    // split camelCase compounds. Catches "Maria LopezdeVega" →
    // "Maria Lopez de Vega" (and "AnAlex Turner" → "An Alex Turner").
    const camelSplit = displayName.replace(/([a-z])([A-Z])/g, "$1 $2");
    add(camelSplit);

    // Variant 3: same camelSplit then German digraph collapse.
    const camelDe = camelSplit
      .replace(/ue/g, "u").replace(/oe/g, "o")
      .replace(/ae/g, "a").replace(/ss/g, "s");
    add(camelDe);

    // Variant 4: original with German digraph collapse only.
    const de = displayName
      .replace(/ue/g, "u").replace(/oe/g, "o")
      .replace(/ae/g, "a").replace(/ss/g, "s");
    add(de);

    // Variant 5: trimmed (no short middles) with German digraph collapse.
    if (tokens.length > 2) {
      const trimmedDe = tokens
        .filter((t, i) => i === 0 || i === tokens.length - 1 || t.length > 2)
        .join(" ")
        .replace(/ue/g, "u").replace(/oe/g, "o")
        .replace(/ae/g, "a").replace(/ss/g, "s");
      add(trimmedDe);
    }

    // Variant 6 (LAST RESORT): last token only — surnames are usually
    // unique enough that a single CQL hit can be trusted. The caller
    // filters out multi-hit results except when one of the earlier
    // variants matched exactly.
    if (tokens.length >= 2) {
      add(tokens[tokens.length - 1]);
    }
    // Variant 7: last token of the CAMEL-SPLIT form (handles cases like
    // "Maria LopezdeVega" where the surname is a CamelCase compound;
    // the last camel chunk is the true surname).
    const camelTokens = camelSplit.split(/\s+/).filter(Boolean);
    if (camelTokens.length > tokens.length) {
      add(camelTokens[camelTokens.length - 1]);
    }
    return out;
  }

  /**
   * Resolve one token to one OR MORE Cloud accountIds.
   *
   * Returns:
   *   []           — unresolvable; caller treats as failure
   *   [accountId]  — single clean resolve
   *   [a, b, ...]  — multiple Cloud accounts share the resolved name
   *                  pattern (e.g. two different users both named
   *                  "John Roe" on the trial tenant). Per user
   *                  request, we return ALL matches and let the macro
   *                  render them as multiple cards rather than skip the
   *                  page.
   *
   * Strategy:
   *   1. accountId-shaped token        -> use as-is
   *   2. CSV mapping override          -> direct hit
   *   3. On-disk cache                 -> direct hit
   *   4. Jira /rest/api/3/user/search  -> only if Jira product is enabled
   *   5. Confluence CQL fallback       -> derive displayName from email
   *      and search `type=user AND user.fullname~"<name>"`
   */
  async resolveUser(token) {
    if (!token) return [];
    const key = String(token).trim().toLowerCase();
    if (!key) return [];

    // Already an accountId?
    if (this._looksLikeAccountId(token)) {
      return [String(token).trim()];
    }

    // CSV mapping override (single mapped accountId)
    if (this.userMapping.has(key)) {
      this.stats.mappingHits++;
      return [this.userMapping.get(key)];
    }

    // Persistent cache. Old caches stored string|null; new caches store
    // array. Accept both for backward compat.
    if (this.userCache.has(key)) {
      this.stats.cacheHits++;
      const cached = this.userCache.get(key);
      if (Array.isArray(cached)) return cached.slice();
      return cached ? [cached] : [];
    }

    this.stats.apiLookups++;
    let accountIds = [];
    let jiraFailedAuth = false;

    // Path 1: Jira user-search (best on multi-product Cloud tenants)
    try {
      const users = await this.cloudClient.searchJiraUsersByQuery(token, 10);
      if (Array.isArray(users) && users.length > 0) {
        // Prefer exact email match; if none, accept exact displayName match
        // (one or more). If only fuzzy and one result, take it.
        const exactByEmail = users.filter(
          (u) => u.emailAddress && u.emailAddress.toLowerCase() === key,
        );
        const exactByName = users.filter(
          (u) => u.displayName && u.displayName.toLowerCase() === key,
        );
        const exactSet = exactByEmail.length > 0 ? exactByEmail : exactByName;
        if (exactSet.length === 1) {
          accountIds = [exactSet[0].accountId];
        } else if (exactSet.length > 1) {
          accountIds = exactSet.map((u) => u.accountId).filter(Boolean);
          this.stats.multiMatched++;
        } else if (users.length === 1) {
          accountIds = [users[0].accountId].filter(Boolean);
        }
      }
    } catch (e) {
      if (e.statusCode === 401 || e.statusCode === 403) {
        jiraFailedAuth = true;
      } else {
        this.log(`  [Resolver] Jira user-search error for "${token}": ${e.message}`);
      }
    }

    // Path 2: Confluence CQL fallback (Confluence-only tenants)
    if (accountIds.length === 0) {
      const display = this._deriveDisplayNameFromEmail(token);
      if (display) {
        const variants = this._deriveQueryVariants(display);
        const norm = (s) => (s || "").toLowerCase()
          .normalize("NFD").replace(/[̀-ͯ]/g, "");
        const targets = new Set(variants.map((v) => norm(v)));
        targets.add(norm(token));
        let candidates = [];
        for (const variant of variants) {
          try {
            const users = await this.cloudClient.searchUsers(variant, 10);
            if (Array.isArray(users) && users.length > 0) {
              candidates = candidates.concat(users);
            }
          } catch (e) {
            this.log(`  [Resolver] Confluence user-search error for "${token}" → "${variant}": ${e.message}`);
          }
          if (candidates.length > 0) break; // first variant that hits wins
        }
        if (candidates.length > 0) {
          // Dedupe by accountId
          const seen = new Set();
          const unique = [];
          for (const u of candidates) {
            if (u.accountId && !seen.has(u.accountId)) {
              seen.add(u.accountId);
              unique.push(u);
            }
          }
          const exactMatches = unique.filter((u) =>
            targets.has(norm(u.publicName)) ||
            targets.has(norm(u.displayName)) ||
            targets.has(norm(u.email)),
          );
          if (exactMatches.length === 1) {
            accountIds = [exactMatches[0].accountId];
          } else if (exactMatches.length > 1) {
            // Multiple accounts share the same name (e.g. two "Christoph
            // Roe" accounts on the tenant). Per user request, return
            // ALL of them — the macro will render multiple cards. Better
            // than skipping the page or guessing wrong.
            accountIds = exactMatches.map((u) => u.accountId);
            this.stats.multiMatched++;
            this.log(`  [Resolver] MULTI-MATCH: ${exactMatches.length} Cloud accounts share name pattern for "${token}" → emitting all ${exactMatches.length} as cards`);
          } else if (unique.length === 1) {
            accountIds = [unique[0].accountId];
          } else if (unique.length > 1) {
            this.stats.ambiguous++;
            this.log(`  [Resolver] AMBIGUOUS fuzzy match for "${token}" → ${JSON.stringify(variants)} (${unique.length} candidates, no exact)`);
          }
        }
      }
    }

    // Suppress noisy "Jira auth failed" log on the first miss only
    if (jiraFailedAuth && !this._jiraAuthFailedLogged) {
      this._jiraAuthFailedLogged = true;
      this.log(`  [Resolver] NOTE: Jira /rest/api/3/user/search returned 401 — falling back to Confluence CQL user-search for all tokens`);
    }

    this.userCache.set(key, accountIds);
    this._persistCache();

    if (accountIds.length > 0) this.stats.apiHits++;
    else this.stats.apiMisses++;
    return accountIds;
  }

  /**
   * Resolve a list of tokens. Returns:
   *   { accountIds: string[], unresolved: string[] }
   * preserving the original order of resolved entries. Multi-matched
   * tokens contribute multiple accountIds.
   */
  async resolveMany(tokens) {
    const accountIds = [];
    const unresolved = [];
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { accountIds, unresolved };
    }
    for (const t of tokens) {
      const ids = await this.resolveUser(t);
      if (ids.length > 0) accountIds.push(...ids);
      else unresolved.push(t);
    }
    return { accountIds, unresolved };
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = IdentityResolver;
