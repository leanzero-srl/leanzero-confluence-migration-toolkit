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

    // Cache: spaceKey -> spaceId (v2 API uses numeric IDs)
    this._spaceIdCache = new Map();
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

  /**
   * Make an HTTPS request to the Cloud Confluence REST API.
   * Uses separate counters for rate limit vs server error/network retries.
   */
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

          // Rate limit handling with exponential backoff
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

          // Server errors with retry
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

          // 204 No Content
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

  /**
   * Test connection to Cloud Confluence (v2 API)
   */
  async testConnection() {
    try {
      await this.makeRequest("GET", "/api/v2/spaces?limit=1");
      return true;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Resolve a space key to a numeric space ID (v2 API uses IDs, not keys).
   * Results are cached for the session.
   *
   * @param {string} spaceKey
   * @returns {string|null} space ID or null
   */
  async resolveSpaceId(spaceKey) {
    if (this._spaceIdCache.has(spaceKey)) {
      return this._spaceIdCache.get(spaceKey);
    }

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
   * Find a Cloud page by space key and title using the v2 API.
   * Returns the page object or null if not found.
   *
   * v2 API: GET /api/v2/pages?space-id=ID&title=TITLE&body-format=storage&limit=1
   *
   * @param {string} spaceKey
   * @param {string} title
   * @returns {object|null} page with id, title, spaceId, body, version
   */
  async findPageBySpaceAndTitle(spaceKey, title) {
    const spaceId = await this.resolveSpaceId(spaceKey);
    if (!spaceId) {
      console.log(`  [Cloud] Space "${spaceKey}" not found in Cloud`);
      return null;
    }

    const encodedTitle = encodeURIComponent(title);

    try {
      const response = await this.makeRequest(
        "GET",
        `/api/v2/pages?space-id=${spaceId}&title=${encodedTitle}&body-format=storage&limit=1`,
      );

      const results = response.results || [];
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      if (error.statusCode === 400) {
        console.log(`  [Cloud] Page search failed for "${title}" in ${spaceKey}: ${error.message}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a Cloud page's content by ID with storage body and version.
   *
   * v2 API: GET /api/v2/pages/{id}?body-format=storage
   *
   * @param {string} pageId
   * @returns {object} page with body.storage.value, version.number, title
   */
  async getPageContent(pageId) {
    return await this.makeRequest(
      "GET",
      `/api/v2/pages/${pageId}?body-format=storage`,
    );
  }

  /**
   * Update a Cloud page's storage content using v2 API.
   * Handles 409 version conflicts by re-fetching and retrying once.
   * On 404 (often a masked permission error in v2), falls back to v1
   * PUT to either succeed where v1 has different perms semantics OR to
   * surface the real error (e.g. PermissionException vs opaque 404).
   *
   * v2 API: PUT /api/v2/pages/{id}
   * Required fields: id, status, title, body, version
   *
   * @param {string} pageId
   * @param {string} title
   * @param {string} newStorageBody - new storage format HTML
   * @param {number} currentVersion - current version number
   * @param {string} [currentStatus] - actual page status from GET (default "current")
   * @returns {{success: boolean, error: string|null}}
   */
  async updatePageContent(pageId, title, newStorageBody, currentVersion, currentStatus) {
    const payload = {
      id: String(pageId),
      status: currentStatus || "current",
      title,
      body: {
        representation: "storage",
        value: newStorageBody,
      },
      version: {
        number: currentVersion + 1,
        message: "HTML macro fix - automated",
      },
    };

    try {
      await this.makeRequest("PUT", `/api/v2/pages/${pageId}`, payload);
      return { success: true, error: null };
    } catch (error) {
      // Handle version conflict - re-fetch and retry once
      if (error.statusCode === 409) {
        console.log(`  [Cloud] Version conflict for page ${pageId}, re-fetching...`);
        try {
          const page = await this.getPageContent(pageId);
          const newVersion = page.version.number;
          payload.version.number = newVersion + 1;
          if (page.status) payload.status = page.status;
          await this.makeRequest("PUT", `/api/v2/pages/${pageId}`, payload);
          return { success: true, error: null };
        } catch (retryError) {
          return { success: false, error: `Version conflict retry failed: ${retryError.message}` };
        }
      }
      // v2 quirk: a 404 here often masks a 403 (no edit permission). Try v1
      // PUT to either succeed (v1 sometimes accepts what v2 rejects, e.g.
      // homepages or odd content types) or surface a clearer error message.
      if (error.statusCode === 404) {
        const v1 = await this._updatePageContentV1(pageId, title, newStorageBody, currentVersion);
        if (v1.success) return v1;
        // Combine both errors for diagnostic clarity
        return {
          success: false,
          error: `v2 404 NOT_FOUND (likely permission denied) + v1 fallback: ${v1.error}`,
        };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * v1 PUT fallback. Used when v2 PUT returns 404 — v1 returns clearer
   * error codes (e.g. 403 PermissionException) and sometimes accepts
   * pages that v2 rejects (homepages, odd content types).
   */
  async _updatePageContentV1(pageId, title, newStorageBody, currentVersion) {
    const v1Payload = {
      id: String(pageId),
      type: "page",
      title,
      body: {
        storage: {
          value: newStorageBody,
          representation: "storage",
        },
      },
      version: {
        number: currentVersion + 1,
        message: "HTML macro fix - automated (v1 fallback)",
      },
    };
    try {
      await this.makeRequest("PUT", `/rest/api/content/${pageId}`, v1Payload);
      return { success: true, error: null };
    } catch (error) {
      if (error.statusCode === 409) {
        try {
          const cur = await this.makeRequest(
            "GET",
            `/rest/api/content/${pageId}?expand=version`,
          );
          v1Payload.version.number = (cur.version?.number || currentVersion) + 1;
          await this.makeRequest("PUT", `/rest/api/content/${pageId}`, v1Payload);
          return { success: true, error: null };
        } catch (retryError) {
          return { success: false, error: `v1 conflict retry failed: ${retryError.message}` };
        }
      }
      return { success: false, error: error.message };
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
