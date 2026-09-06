const https = require("https");
const http = require("http");
const { URL } = require("url");

class DatacenterConfluenceClient {
  // Accepts either:
  //   new DatacenterConfluenceClient(baseUrl, username, password)        // Basic auth
  //   new DatacenterConfluenceClient(baseUrl, null, null, { pat: "..." }) // Bearer (Personal Access Token)
  // For convenience, if `password` is the only credential available and
  // `username` is falsy, `password` is treated as a PAT (Bearer).
  constructor(baseUrl, username, password, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, "");

    const pat = options.pat || (username ? null : password);
    if (pat) {
      this.authHeader = "Bearer " + pat;
    } else {
      this.authHeader =
        "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }

    this.requestCount = 0;
    this.errorCount = 0;
  }

  /**
   * Make an HTTP request to the Datacenter Confluence API.
   * Uses separate counters for rate limit vs server error/network retries.
   */
  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
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

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (
            res.statusCode === 429 &&
            state.rateLimitAttempts < maxRateLimitRetries
          ) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
            console.log(
              `  [DC] Rate limited (429), retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
              `  [DC] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
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

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `DC Confluence API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(data));
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
            `  [DC] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
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
          console.log(`  [DC] Request timeout, retrying in ${delay / 1000}s`);
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
        reject(new Error(`DC Confluence API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Test connection to Datacenter Confluence
   */
  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/space?limit=1");
      return true;
    } catch (error) {
      console.error(`  [DC] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Paginated CQL search for content.
   * Calls onPage(results) for each page of results.
   * If onPage returns false, pagination stops.
   *
   * @param {string} cql - CQL query string
   * @param {string} expand - fields to expand (default: "body.storage,version,space")
   * @param {Function} onPage - async callback receiving array of content results
   * @returns {number} total results found
   */
  async searchContentByCql(cql, expand = "body.storage,version,space", onPage) {
    const encodedCql = encodeURIComponent(cql);
    let startAt = 0;
    const limit = 25;
    let totalFound = 0;

    while (true) {
      const apiPath = `/rest/api/content/search?cql=${encodedCql}&expand=${expand}&limit=${limit}&start=${startAt}`;

      let response;
      try {
        response = await this.makeRequest("GET", apiPath);
      } catch (error) {
        if (error.statusCode === 400) {
          console.log(`  [DC] CQL search returned 400, stopping. CQL: ${cql}`);
          return totalFound;
        }
        throw error;
      }

      const results = response.results || [];
      
      // Check if there are more pages to fetch
      // DC search response may not have totalCount in all cases
      if (results.length === 0) break;

      const pageResult = await onPage(results);
      totalFound += results.length;

      if (pageResult === false) break;

      startAt += results.length;

      // Stop if size indicates this is the last page, OR if we've hit the safety limit
      const size = response.size || 0;
      if (size > 0 && size < limit) {
        break; // Last page
      }
      
      // Safety limit to prevent infinite loops on huge datasets
      if (startAt >= 100000) {
        console.log(`  [DC] WARNING: Reached pagination safety limit for CQL search`);
        break;
      }
    }

    return totalFound;
  }

  /**
   * Get a single page's content by ID
   *
   * @param {string} pageId - Confluence page ID
   * @returns {object} page content with body.storage, version, space
   */
  async getPageContent(pageId) {
    return await this.makeRequest(
      "GET",
      `/rest/api/content/${pageId}?expand=body.storage,version,space`,
    );
  }

  /**
   * Get all spaces (paginated)
   *
   * @returns {Array<{key: string, name: string}>}
   */
  async getAllSpaces() {
    const spaces = [];
    let startAt = 0;
    const limit = 100;

    while (true) {
      const response = await this.makeRequest(
        "GET",
        `/rest/api/space?limit=${limit}&start=${startAt}`,
      );

      const results = response.results || [];
      if (results.length === 0) break;

      for (const space of results) {
        spaces.push({ key: space.key, name: space.name });
      }

      // If we got fewer results than the limit, we've reached the last page
      if (results.length < limit) break;

      startAt += results.length;
    }

    return spaces;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
    };
  }
}

module.exports = DatacenterConfluenceClient;