const https = require("https");
const { URL } = require("url");

/**
 * Build the value that goes after "Basic " in the Authorization header.
 *
 * Normally this is base64("email:apiToken"). But if the user supplies an
 * already-pre-encoded value in CLOUD_API_TOKEN (the whole base64 string),
 * we must NOT re-encode — doing so would double-encode and the Cloud API
 * would reject auth with 401.
 *
 * Detection: if the token decodes cleanly as UTF-8, contains a colon, and
 * the portion before the colon matches the supplied email, treat it as
 * pre-encoded and use directly.
 */
function buildBasicAuthValue(email, apiToken) {
  if (typeof apiToken === "string" && apiToken.length > 0) {
    // Strict base64 character set check (URL-safe variants excluded)
    const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(apiToken);
    if (looksBase64) {
      let decoded = null;
      try {
        decoded = Buffer.from(apiToken, "base64").toString("utf8");
      } catch { /* fall through */ }
      if (
        decoded &&
        decoded.includes(":") &&
        (!email || decoded.startsWith(email + ":"))
      ) {
        return apiToken;
      }
    }
  }
  return Buffer.from(`${email}:${apiToken}`).toString("base64");
}

/**
 * Confluence Cloud client for the nested-macro un-nester.
 *
 * Combines:
 *   v2 /api/v2/pages/{id}?body-format=storage    (GET, PUT) — canonical write path
 *   v1 /rest/api/content/search?cql=...          (GET)      — discovery (not deprecated per RFC-19)
 *
 * Adapted from confluence/html-macro/src/cloudConfluenceClient.js and
 * confluence/visibility-macro/src/cloudConfluenceClient.js.
 */
class CloudConfluenceClient {
  constructor(baseUrl, email, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader = "Basic " + buildBasicAuthValue(email, apiToken);
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
    this._spaceIdCache = new Map();
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
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

      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Cloud API rate limit exceeded after ${maxRateLimitRetries} attempts: ${method} ${path}`,
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
              () => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 10000);
            console.log(
              `  [Cloud] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
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
              `Cloud API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
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
          console.log(`  [Cloud] Connection error: ${err.message}, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
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
          console.log(`  [Cloud] Request timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(new Error(`Cloud API request timeout: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/api/v2/spaces?limit=1");
      return true;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return false;
    }
  }

  async resolveSpaceId(spaceKey) {
    if (this._spaceIdCache.has(spaceKey)) return this._spaceIdCache.get(spaceKey);

    try {
      const response = await this.makeRequest(
        "GET",
        `/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`,
      );
      const results = response.results || [];
      if (results.length === 0) return null;
      const spaceId = String(results[0].id);
      this._spaceIdCache.set(spaceKey, spaceId);
      return spaceId;
    } catch (error) {
      console.log(`  [Cloud] Failed to resolve space key "${spaceKey}": ${error.message}`);
      return null;
    }
  }

  /**
   * CQL search with cursor pagination + start-based fallback + dedup by ID.
   * onPage(results) is called once per page of results; return false to stop early.
   * Adapted from confluence/visibility-macro/src/cloudConfluenceClient.js.
   */
  async searchContentByCql(cql, expand, onPage) {
    const encodedCql = encodeURIComponent(cql);
    const limit = 50;
    const seen = new Set();
    let totalFound = 0;
    let nextPath = `/rest/api/content/search?cql=${encodedCql}&expand=${expand}&limit=${limit}`;
    let pageCount = 0;
    const maxPages = 5000;

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

      const fresh = results.filter((r) => {
        const id = r.id || r.content?.id;
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (fresh.length === 0) {
        console.log(
          `  [Cloud] Pagination returned only duplicates on page ${pageCount}. Stopping to avoid loop.`,
        );
        break;
      }

      const pageResult = await onPage(fresh);
      totalFound += fresh.length;
      if (pageResult === false) break;

      const nextLink = response._links?.next;
      if (nextLink) {
        nextPath = nextLink.startsWith(this.basePath)
          ? nextLink.substring(this.basePath.length)
          : nextLink;
      } else {
        const size = response.size || results.length;
        if (size < limit) break;
        const url = new URL(`https://x${nextPath}`);
        const curStart = parseInt(url.searchParams.get("start") || "0", 10);
        url.searchParams.set("start", String(curStart + results.length));
        nextPath = url.pathname + url.search;
      }
    }

    if (pageCount >= maxPages) {
      console.log(`  [Cloud] WARNING: reached pagination safety limit (${maxPages} pages)`);
    }

    return totalFound;
  }

  /**
   * Fetch a single page's storage body + version via v2 API.
   *
   * Shape of response:
   *   { id, title, version: { number }, body: { storage: { value, representation } } }
   */
  async getPageWithStorage(pageId) {
    return await this.makeRequest(
      "GET",
      `/api/v2/pages/${pageId}?body-format=storage`,
    );
  }

  /**
   * Get a Cloud page (v1) with ADF body and version. Returns the full
   * page object; the rendered ADF is at `page.body.atlas_doc_format.value`
   * (a JSON string — caller must JSON.parse).
   *
   * Used by the read-only diagnostic scripts (`tools/diagnose_scaffolding.js`)
   * to inspect Cloud's ADF output for migration error markers without
   * touching the page. Pattern adapted from
   * confluence/visibility-macro/src/cloudConfluenceClient.js:311-316.
   */
  async getPageAdf(pageId) {
    return await this.makeRequest(
      "GET",
      `/rest/api/content/${pageId}?expand=body.atlas_doc_format,version,space`,
    );
  }

  /**
   * Update a page's storage body via v2 API.
   *
   * On 409 (version conflict), this method does NOT auto-retry. Instead it
   * surfaces the conflict to the caller via `{success:false, statusCode:409}`.
   * The caller is expected to refetch the page, re-run its content
   * transformation against the FRESH storage, and PUT again — otherwise a
   * concurrent editor's work would be silently overwritten by a stale body.
   */
  async updatePageStorage(pageId, title, newStorageBody, currentVersion, message) {
    const payload = {
      id: String(pageId),
      status: "current",
      title,
      body: {
        representation: "storage",
        value: newStorageBody,
      },
      version: {
        number: currentVersion + 1,
        message: message || "Un-nest nested macros - automated",
      },
    };

    try {
      await this.makeRequest("PUT", `/api/v2/pages/${pageId}`, payload);
      return { success: true, error: null };
    } catch (error) {
      return {
        success: false,
        statusCode: error.statusCode,
        error: error.message,
      };
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
