const https = require("https");
const { URL } = require("url");

class CloudConfluenceClient {
  constructor(baseUrl, email, apiToken) {
    // baseUrl should include /wiki, e.g. https://site.atlassian.net/wiki
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader = "Basic " + this._buildBasicCredential(email, apiToken);
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  // Accept either a raw API token (we base64 "email:token") or an
  // already-base64-encoded "email:token" string in CLOUD_API_TOKEN.
  // Detect the latter by base64-decoding and looking for a ":".
  _buildBasicCredential(email, apiToken) {
    const t = (apiToken || "").trim();
    if (/^[A-Za-z0-9+/]+=*$/.test(t) && t.length % 4 === 0) {
      try {
        const decoded = Buffer.from(t, "base64").toString("utf8");
        if (decoded.includes(":")) return t;
      } catch {
        // fall through
      }
    }
    return Buffer.from(`${email}:${t}`).toString("base64");
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path: this.basePath + path,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState)
          .then(resolve)
          .catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Cloud Confluence API rate limit exceeded after ${maxRateLimitRetries} attempts: ${method} ${path}`,
              );
              error.statusCode = 429;
              error.isRateLimit = true;
              reject(error);
              return;
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            console.log(
              `  [Cloud] Rate limited (429), waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(
              1000 * Math.pow(2, state.serverErrorAttempts),
              10000,
            );
            console.log(
              `  [Cloud] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (res.statusCode === 204) {
            resolve(null);
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Cloud Confluence API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }

          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [Cloud] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [Cloud] Request timeout, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(new Error(`Cloud Confluence API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/space?limit=1");
      return true;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Paginated CQL search via v1 endpoint /rest/api/content/search.
   *
   * Cloud's CQL endpoint returns cursor-based pagination via
   * _links.next (a relative URL containing &cursor=...). The legacy
   * start=N pagination is unreliable for large result sets — for
   * tenant-wide queries it can simply return the same page over and
   * over. So we follow _links.next when present, and dedupe by content
   * ID as a final safety belt.
   *
   * @param {string} cql
   * @param {string} expand
   * @param {Function} onPage async (results) => boolean|undefined
   * @returns {number} total results processed (post-dedup)
   */
  async searchContentByCql(cql, expand = "body.storage,version,space", onPage) {
    const encodedCql = encodeURIComponent(cql);
    const limit = 50;
    const seen = new Set();
    let totalFound = 0;
    // Initial path uses start=0; subsequent pages use _links.next when present.
    let nextPath = `/rest/api/content/search?cql=${encodedCql}&expand=${expand}&limit=${limit}`;
    let pageCount = 0;
    const maxPages = 5000; // generous safety: 5000 * 50 = 250k pages cap

    while (nextPath && pageCount < maxPages) {
      pageCount++;
      let response;
      try {
        response = await this.makeRequest("GET", nextPath);
      } catch (error) {
        if (error.statusCode === 400) {
          console.log(`  [Cloud] CQL search returned 400, stopping. CQL: ${cql}`);
          return totalFound;
        }
        throw error;
      }

      const results = response.results || [];
      if (results.length === 0) break;

      // Dedup by id; if EVERY result is a duplicate, the cursor is broken
      // and we abort to avoid infinite loops.
      const fresh = results.filter((r) => {
        const id = r.id || r.content?.id;
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (fresh.length === 0) {
        console.log(
          `  [Cloud] Pagination returned only duplicates on page ${pageCount} (received ${results.length}). Stopping to avoid loop.`,
        );
        break;
      }

      const pageResult = await onPage(fresh);
      totalFound += fresh.length;

      if (pageResult === false) break;

      // Follow _links.next when present (cursor-based pagination).
      const nextLink = response._links?.next;
      if (nextLink) {
        // _links.next is a relative path beginning with /wiki/rest/api/...
        // strip the basePath so makeRequest's path concatenation matches.
        nextPath = nextLink.startsWith(this.basePath)
          ? nextLink.substring(this.basePath.length)
          : nextLink;
      } else {
        // No next link: use legacy start increment as a fallback for old
        // Cloud responses, then stop after this iteration if size < limit.
        const size = response.size || results.length;
        if (size < limit) break;
        const url = new URL(`https://x${nextPath}`);
        const curStart = parseInt(url.searchParams.get("start") || "0", 10);
        url.searchParams.set("start", String(curStart + results.length));
        nextPath = url.pathname + url.search;
      }
    }

    if (pageCount >= maxPages) {
      console.log(`  [Cloud] WARNING: Reached pagination safety limit (${maxPages} pages) for CQL: ${cql}`);
    }

    return totalFound;
  }

  /**
   * Get a Cloud page (v1) with storage body and version.
   * @param {string} pageId
   */
  async getPageContent(pageId) {
    return await this.makeRequest(
      "GET",
      `/rest/api/content/${pageId}?expand=body.storage,version,space`,
    );
  }

  /**
   * Get a Cloud page (v1) with ADF body and version. Returns the full
   * page object; the parsed ADF is at `page.body.atlas_doc_format.value`
   * (a JSON string).
   *
   * @param {string} pageId
   */
  async getPageAdf(pageId) {
    return await this.makeRequest(
      "GET",
      `/rest/api/content/${pageId}?expand=body.atlas_doc_format,version,space`,
    );
  }

  /**
   * Update a Cloud page using ADF body. Handles 409 conflicts by
   * re-fetching once and retrying with the new version number (the
   * caller-supplied ADF is reused as-is; conflict retry assumes the
   * ADF is independently safe to apply to the newer version, which is
   * true for our visibility-macro patch since we mutate by macroId).
   *
   * @param {string} pageId
   * @param {string} title
   * @param {string} type
   * @param {object} adf - ADF document object (will be JSON.stringify'd)
   * @param {number} currentVersion
   */
  /**
   * Fetch a Cloud page expanded with its STORAGE representation (the
   * pre-migration XHTML format). Used as a fallback when ADF is broken
   * (e.g. CCMA legacy-content wrappers, or Confluence renderer errors).
   *
   * Returns { id, title, type, version, space, body: { storage: { value, representation } } }
   */
  async getPageStorage(pageId) {
    return await this.makeRequest(
      "GET",
      `/rest/api/content/${pageId}?expand=body.storage,version,space`,
    );
  }

  /**
   * PUT a page's body using STORAGE representation (legacy XHTML). Use
   * this for pages where ADF is unusable but storage is intact, or for
   * surgical edits to legacy macros that aren't visible in ADF.
   *
   * @param {string} pageId
   * @param {string} title
   * @param {string} type
   * @param {string} storageXml
   * @param {number} currentVersion
   * @param {string} versionMessage
   */
  async updatePageStorage(pageId, title, type, storageXml, currentVersion, versionMessage) {
    const payload = {
      id: String(pageId),
      type: type || "page",
      title,
      body: {
        storage: {
          value: storageXml,
          representation: "storage",
        },
      },
      version: {
        number: currentVersion + 1,
        message: versionMessage || "Visibility macro migration (storage path)",
      },
    };
    try {
      await this.makeRequest("PUT", `/rest/api/content/${pageId}`, payload);
      return { success: true, error: null };
    } catch (error) {
      if (error.statusCode === 409) {
        try {
          const page = await this.getPageStorage(pageId);
          payload.version.number = page.version.number + 1;
          await this.makeRequest("PUT", `/rest/api/content/${pageId}`, payload);
          return { success: true, error: null };
        } catch (retryError) {
          return { success: false, error: `Version conflict retry failed: ${retryError.message}` };
        }
      }
      return { success: false, error: error.message };
    }
  }

  async updatePageAdf(pageId, title, type, adf, currentVersion) {
    const payload = {
      id: String(pageId),
      type: type || "page",
      title,
      body: {
        atlas_doc_format: {
          value: JSON.stringify(adf),
          representation: "atlas_doc_format",
        },
      },
      version: {
        number: currentVersion + 1,
        message: "Visibility macro migration: legacy show-if -> Forge ecosystem",
      },
    };

    try {
      await this.makeRequest("PUT", `/rest/api/content/${pageId}`, payload);
      return { success: true, error: null };
    } catch (error) {
      if (error.statusCode === 409) {
        console.log(`  [Cloud] Version conflict for page ${pageId}, re-fetching...`);
        try {
          const page = await this.getPageAdf(pageId);
          payload.version.number = page.version.number + 1;
          await this.makeRequest("PUT", `/rest/api/content/${pageId}`, payload);
          return { success: true, error: null };
        } catch (retryError) {
          return { success: false, error: `Version conflict retry failed: ${retryError.message}` };
        }
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Look up a Cloud group by name using the picker endpoint.
   * Returns {id, name} or null if no exact match.
   *
   * /rest/api/group/by-name was removed (HTTP 410). Picker is the
   * supported replacement and returns multiple fuzzy matches; we
   * filter for an exact (case-insensitive) match on the name.
   *
   * @param {string} groupName
   */
  async getGroupByName(groupName) {
    const encoded = encodeURIComponent(groupName);
    try {
      // Picker returns fuzzy matches; the target may be deep in the list.
      // Use a large limit (max ~200) and filter for exact match.
      const response = await this.makeRequest(
        "GET",
        `/rest/api/group/picker?query=${encoded}&limit=200`,
      );
      const results = (response && response.results) || [];
      const target = groupName.toLowerCase();
      const exact = results.find(
        (g) => (g.name || "").toLowerCase() === target,
      );
      if (!exact) return null;
      return {
        id: exact.id,
        name: exact.name,
        type: exact.usageType || "group",
      };
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Search Cloud users via CQL (type=user). Returns array of user objects with accountId.
   *
   * @param {string} query - free-text query (matched against fullname / email)
   * @param {number} limit
   */
  async searchUsers(query, limit = 10) {
    // Escape double quotes in the query
    const safeQuery = String(query).replace(/"/g, '\\"');
    const cql = `type=user AND user.fullname~"${safeQuery}"`;
    const encoded = encodeURIComponent(cql);
    try {
      const response = await this.makeRequest(
        "GET",
        `/rest/api/search?cql=${encoded}&limit=${limit}`,
      );
      const results = response.results || [];
      return results
        .map((r) => r.user || r)
        .filter((u) => u && u.accountId);
    } catch (error) {
      if (error.statusCode === 400) {
        return [];
      }
      throw error;
    }
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = CloudConfluenceClient;
