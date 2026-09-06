const https = require("https");
const { URL } = require("url");

/**
 * Minimal Confluence Cloud client for the grant-space-admin script.
 *
 * Endpoints used:
 *   v1 POST /wiki/rest/api/space/{spaceKey}/permission   (grant permission)
 *   v1 GET  /wiki/rest/api/user/current                  (current accountId)
 *   v2 GET  /wiki/api/v2/spaces                          (list spaces, cursor paging)
 *   v2 GET  /wiki/api/v2/spaces/{id}/permissions         (check existing perms)
 *
 * Shares the auth / retry / backoff design with the other confluence/* scripts.
 */
function buildBasicAuthValue(email, apiToken) {
  if (typeof apiToken === "string" && apiToken.length > 0) {
    const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(apiToken);
    if (looksBase64) {
      let decoded = null;
      try { decoded = Buffer.from(apiToken, "base64").toString("utf8"); } catch { /* ignore */ }
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

class CloudClient {
  constructor(baseUrl, email, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader = "Basic " + buildBasicAuthValue(email, apiToken);
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimit = 3;
    const maxServer = 3;

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
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimit) {
              const err = new Error(`Rate limit: ${method} ${path}`);
              err.statusCode = 429;
              reject(err);
              return;
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            console.log(`  [Cloud] 429 — waiting ${delay / 1000}s`);
            setTimeout(() => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }), delay);
            return;
          }

          if (res.statusCode >= 500 && res.statusCode < 600 && state.serverErrorAttempts < maxServer) {
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 10000);
            console.log(`  [Cloud] ${res.statusCode} — retrying in ${delay / 1000}s`);
            setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
            return;
          }

          if (res.statusCode === 204) {
            resolve({ statusCode: 204, body: null });
            return;
          }

          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const err = new Error(`Cloud ${method} ${path} ${res.statusCode}: ${typeof parsed === "string" ? parsed.substring(0, 500) : JSON.stringify(parsed).substring(0, 500)}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            reject(err);
            return;
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServer) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
          return;
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServer) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
          return;
        }
        reject(new Error(`Timeout: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /** GET /wiki/rest/api/user/current → current user's accountId + displayName. */
  async getCurrentUser() {
    const res = await this.makeRequest("GET", "/rest/api/user/current");
    return res.body;
  }

  /**
   * List all spaces, paginated via cursor. Yields batches via the onPage callback.
   * Returns total count.
   */
  async listAllSpaces(onPage, opts = {}) {
    const limit = opts.limit || 250;
    let nextPath = `/api/v2/spaces?limit=${limit}`;
    let total = 0;
    const seen = new Set();
    let pageCount = 0;
    const maxPages = 1000;

    while (nextPath && pageCount < maxPages) {
      pageCount++;
      const res = await this.makeRequest("GET", nextPath);
      const results = res.body?.results || [];
      if (results.length === 0) break;

      const fresh = results.filter((s) => {
        const id = String(s.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (fresh.length === 0) {
        console.log(`  [Cloud] Duplicate-only page ${pageCount} — stopping`);
        break;
      }

      const cont = await onPage(fresh);
      total += fresh.length;
      if (cont === false) break;

      const nextLink = res.body?._links?.next;
      if (!nextLink) break;
      nextPath = nextLink.startsWith(this.basePath)
        ? nextLink.substring(this.basePath.length)
        : nextLink;
    }
    return total;
  }

  /** GET permissions for a space (v2). Returns full array by consuming pagination. */
  async getSpacePermissions(spaceId) {
    const all = [];
    let nextPath = `/api/v2/spaces/${spaceId}/permissions?limit=250`;
    let pageCount = 0;
    while (nextPath && pageCount < 100) {
      pageCount++;
      const res = await this.makeRequest("GET", nextPath);
      const results = res.body?.results || [];
      all.push(...results);
      const nextLink = res.body?._links?.next;
      if (!nextLink) break;
      nextPath = nextLink.startsWith(this.basePath)
        ? nextLink.substring(this.basePath.length)
        : nextLink;
    }
    return all;
  }

  /**
   * Grant a permission to a user on a space (v1 API).
   *
   * POST /wiki/rest/api/space/{spaceKey}/permission
   * body: { subject:{type,identifier}, operation:{key,target}, _links:{} }
   */
  async grantSpacePermission(spaceKey, accountId, operationKey, operationTarget) {
    const body = {
      subject: { type: "user", identifier: accountId },
      operation: { key: operationKey, target: operationTarget },
      _links: {},
    };
    return await this.makeRequest(
      "POST",
      `/rest/api/space/${encodeURIComponent(spaceKey)}/permission`,
      body,
    );
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = CloudClient;
