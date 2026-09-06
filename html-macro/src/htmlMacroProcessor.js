class HtmlMacroProcessor {
  constructor(dcClient, cloudClient, planManager, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;
    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 3;
    this.spaceKeys = options.spaceKeys || [];
    this.retryFailed = options.retryFailed || false;
    this.replacementMode = options.replacementMode || "code";
    this.macroTypes = options.macroTypes || ["html", "css"];
    // "sites" → only global/site spaces (default; matches Cloud which has no personal spaces).
    // "personal" → only personal spaces (keys prefixed with "~").
    // "all" → both. Ignored when --space is given (explicit keys take priority).
    this.spaceType = options.spaceType || "sites";
    this.log = options.log || console.log;

    // Stats
    this.stats = {
      spacesScanned: 0,
      pagesScanned: 0,
      pagesWithMacros: 0,
      pagesMatchedInCloud: 0,
      pagesNotFoundInCloud: 0,
      pagesAlreadyInSync: 0,
      pagesUpdated: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
    };
  }

  // ─────────────────────────────────────────────────
  //  MACRO EXTRACTION (REGEX)
  // ─────────────────────────────────────────────────

  /**
   * Extract all macros of a given type from Confluence storage format.
   * Handles both CDATA-wrapped and plain text body variants.
   *
   * @param {string} storageBody - Confluence storage format XML
   * @param {string} macroName - macro type name (e.g. "html", "css")
   * @returns {Array<{index: number, content: string, fullMatch: string}>}
   */
  extractMacros(storageBody, macroName) {
    if (!storageBody) return [];

    const macros = [];
    const escapedName = macroName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Pattern 1: macro with CDATA body (most common)
    const cdataRegex = new RegExp(
      `<ac:structured-macro[^>]*?ac:name\\s*=\\s*"${escapedName}"[^>]*?>[\\s\\S]*?<ac:plain-text-body>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/ac:plain-text-body>[\\s\\S]*?<\\/ac:structured-macro>`,
      "g",
    );

    let match;
    while ((match = cdataRegex.exec(storageBody)) !== null) {
      macros.push({
        index: macros.length,
        content: match[1],
        fullMatch: match[0],
      });
    }

    // Pattern 2: macro without CDATA (fallback - plain text body)
    if (macros.length === 0) {
      const plainRegex = new RegExp(
        `<ac:structured-macro[^>]*?ac:name\\s*=\\s*"${escapedName}"[^>]*?>[\\s\\S]*?<ac:plain-text-body>([\\s\\S]*?)<\\/ac:plain-text-body>[\\s\\S]*?<\\/ac:structured-macro>`,
        "g",
      );

      while ((match = plainRegex.exec(storageBody)) !== null) {
        macros.push({
          index: macros.length,
          content: match[1],
          fullMatch: match[0],
        });
      }
    }

    return macros;
  }

  /**
   * Replace macro blocks of a given type in Cloud storage body with DC content.
   *
   * @param {string} cloudStorageBody - current Cloud page storage body
   * @param {Array<{index: number, dcContent: string}>} dcMacros - DC macro contents
   * @param {string} mode - "raw" (inline content), "macro" (preserve wrapper), or "code" (wrap in code block)
   * @param {string} macroName - macro type name (e.g. "html", "css")
   * @returns {{newBody: string, replacementsMade: number}}
   */
  replaceMacros(cloudStorageBody, dcMacros, mode, macroName) {
    if (!cloudStorageBody || !dcMacros || dcMacros.length === 0) {
      return { newBody: cloudStorageBody, replacementsMade: 0 };
    }

    const label = macroName.toUpperCase();

    // Find all macro blocks of this type in the Cloud body
    const cloudMacros = this.extractMacros(cloudStorageBody, macroName);

    if (cloudMacros.length === 0) {
      this.log(`    WARNING: No ${label} macro blocks found in Cloud page body`);
      return { newBody: cloudStorageBody, replacementsMade: 0 };
    }

    if (cloudMacros.length !== dcMacros.length) {
      this.log(`    WARNING: ${label} macro count mismatch - DC has ${dcMacros.length}, Cloud has ${cloudMacros.length}. Will match by position.`);
    }

    let newBody = cloudStorageBody;
    let replacementsMade = 0;
    const replacementMode = mode || this.replacementMode;

    // Compute each cloud macro's start index in the body BEFORE mutation.
    // Using positional indices (sliced replacement, processed in reverse)
    // is safer than String.prototype.replace(literal) which can hit issues
    // if two macros happen to share an identical fullMatch string.
    const positions = [];
    let cursor = 0;
    for (const cm of cloudMacros) {
      const idx = newBody.indexOf(cm.fullMatch, cursor);
      if (idx === -1) {
        // Should not happen — the matches came from this very body.
        positions.push(-1);
        continue;
      }
      positions.push(idx);
      cursor = idx + cm.fullMatch.length;
    }

    // Process in reverse order to preserve string positions
    const matchCount = Math.min(cloudMacros.length, dcMacros.length);
    for (let i = matchCount - 1; i >= 0; i--) {
      const cloudMacro = cloudMacros[i];
      const dcMacro = dcMacros[i];
      const startIdx = positions[i];
      if (startIdx === -1) continue;

      let replacement;
      if (replacementMode === "code") {
        // Wrap DC content in a Code macro — Cloud preserves CDATA inside code blocks
        replacement =
          `<ac:structured-macro ac:name="code" ac:schema-version="1">`
          + `<ac:parameter ac:name="language">${macroName}</ac:parameter>`
          + `<ac:plain-text-body><![CDATA[${dcMacro.dcContent}]]></ac:plain-text-body>`
          + `</ac:structured-macro>`;
      } else if (replacementMode === "macro") {
        // Preserve the ac:structured-macro wrapper, replace CDATA content
        replacement =
          `<ac:structured-macro ac:name="${macroName}" ac:schema-version="1" ac:macro-id="${this._generateMacroId()}">`
          + `<ac:plain-text-body><![CDATA[${dcMacro.dcContent}]]></ac:plain-text-body>`
          + `</ac:structured-macro>`;
      } else {
        // "raw" mode: inject DC content directly, replacing the entire macro block
        replacement = dcMacro.dcContent;
      }

      newBody = newBody.slice(0, startIdx)
        + replacement
        + newBody.slice(startIdx + cloudMacro.fullMatch.length);
      replacementsMade++;
    }

    return { newBody, replacementsMade };
  }

  _generateMacroId() {
    // Generate a UUID-like macro ID
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.planManager.createPlan(runId);

    // Determine spaces to scan
    let spaces;
    if (this.spaceKeys.length > 0) {
      spaces = this.spaceKeys.map((key) => ({ key, name: key }));
      this.log(`\nScanning ${spaces.length} specified space(s): ${this.spaceKeys.join(", ")}`);
      if (this.spaceType && this.spaceType !== "all") {
        this.log(`  (--space-type=${this.spaceType} ignored — explicit --space keys take priority)`);
      }
    } else {
      // Map our friendly --space-type values to DC API ?type= filter.
      //   sites    → type=global  (DC site spaces; matches Cloud)
      //   personal → type=personal (DC ~user spaces; not present in Cloud)
      //   all      → no filter
      const typeMap = { sites: "global", personal: "personal", all: null };
      const dcType = typeMap[this.spaceType];
      const label = this.spaceType === "all" ? "all (sites + personal)" : this.spaceType;
      this.log(`\nFetching ${label} spaces from DC...`);
      spaces = await this.dcClient.getAllSpaces({ type: dcType });
      this.log(`  Found ${spaces.length} ${label} space(s)`);
    }

    this.log(`  Macro types: ${this.macroTypes.join(", ")}`);

    let totalPagesPlanned = 0;

    for (let i = 0; i < spaces.length; i++) {
      const space = spaces[i];
      this.log(`\n[${i + 1}/${spaces.length}] Scanning space: ${space.key} (${space.name})`);

      try {
        const count = await this._scanSpaceForMacros(space.key);
        totalPagesPlanned += count;
        this.stats.spacesScanned++;
      } catch (error) {
        this.log(`  ERROR scanning space ${space.key}: ${error.message}`);
        if (error.stack) this.log(`  ${error.stack}`);
        continue;
      }

      // Global limit check
      if (this.limit > 0 && totalPagesPlanned >= this.limit) {
        this.log(`\n  Reached global limit of ${this.limit} pages, stopping scan.`);
        break;
      }
    }

    this.planManager.savePlan();
    this.log(`\nPlan built. File: ${this.planManager.planFilePath}`);
    this.log(`  ${this.planManager.formatStats()}`);

    return this.planManager.plan;
  }

  /**
   * Scan a space for all configured macro types.
   * Runs a separate CQL query per macro type, then merges results by page.
   */
  async _scanSpaceForMacros(spaceKey) {
    // Collect macros per page across all macro types
    // Key: dcPageId, Value: { page, htmlMacros: [], cssMacros: [], ... }
    const pageMap = new Map();
    let totalPagesFetched = 0;
    let limitReached = false;

    for (const macroType of this.macroTypes) {
      if (limitReached) break;

      const label = macroType.toUpperCase();
      const cql = `space = "${spaceKey}" AND macro = "${macroType}" AND type = page`;
      let typePagesFetched = 0;

      this.log(`  Searching for ${label} macros in ${spaceKey}...`);

      await this.dcClient.searchContentByCql(cql, "body.storage,version,space", async (results) => {
        if (limitReached) return false;

        for (const page of results) {
          typePagesFetched++;
          // Only count pagesScanned once per unique page
          if (!pageMap.has(page.id)) {
            this.stats.pagesScanned++;
            totalPagesFetched++;
          }

          const storageBody = page.body?.storage?.value;
          if (!storageBody) continue;

          const macros = this.extractMacros(storageBody, macroType);
          if (macros.length === 0) continue;

          if (!pageMap.has(page.id)) {
            pageMap.set(page.id, { page, htmlMacros: [], cssMacros: [] });
          }

          const entry = pageMap.get(page.id);
          const macroKey = `${macroType}Macros`;
          entry[macroKey] = macros.map((m) => ({
            index: m.index,
            dcContent: m.content,
          }));

          // Limit gate. plan.stats.total is only incremented AFTER Cloud
          // resolution (later in this method), so during CQL scanning we
          // cap by the upper-bound: already-planned pages PLUS in-flight
          // candidates collected so far. May over-count slightly (some
          // candidates will be filtered out by the Cloud-match / in-sync
          // check), but that's strictly safer than under-counting and
          // hammering the API past the user's limit.
          if (this.limit > 0 && (this.planManager.plan.stats.total + pageMap.size) >= this.limit) {
            limitReached = true;
            break;
          }
        }

        if (limitReached) return false;
      });

      this.log(`    ${label}: ${typePagesFetched} DC pages returned by CQL`);
    }

    // Now resolve Cloud pages and build plan entries
    const candidates = Array.from(pageMap.values()).filter(
      (entry) => entry.htmlMacros.length > 0 || entry.cssMacros.length > 0,
    );

    if (candidates.length === 0) {
      this.log(`  No pages with macros found in ${spaceKey}`);
      return 0;
    }

    this.stats.pagesWithMacros += candidates.length;

    // Concurrent Cloud lookups
    let idx = 0;
    const resolvedPages = [];

    const worker = async () => {
      while (idx < candidates.length) {
        const current = idx++;
        const entry = candidates[current];
        const { page } = entry;
        const pageTitle = page.title;

        const cloudPage = await this.cloudClient.findPageBySpaceAndTitle(spaceKey, pageTitle);

        if (!cloudPage) {
          this.stats.pagesNotFoundInCloud++;
          this.log(`    Page "${pageTitle}" (DC ID: ${page.id}) - NOT FOUND in Cloud`);
          continue;
        }

        this.stats.pagesMatchedInCloud++;

        // Pre-check: skip pages already in their final state. Two checks:
        //
        //   1. raw/macro mode: Cloud's html/css macros have IDENTICAL content
        //      to DC's. Replacing them would just bump the version with no
        //      visible diff.
        //
        //   2. code mode: Cloud has ZERO html/css macros left to convert.
        //      Either a previous code-mode run already wrapped them in code
        //      blocks, or the macros were stripped pre-migration. Either
        //      way there is nothing for replaceMacros() to find — running
        //      the page through execute would warn "No HTML macro blocks
        //      found in Cloud page body" and skip. Skip earlier and avoid
        //      a wasted GET in phase 2 (huge win on re-runs after a
        //      successful sync — last run was 5362s, mostly redundant).
        const cloudStorageBody = cloudPage.body?.storage?.value;
        let allInSync = false;

        if (cloudStorageBody) {
          if (this.replacementMode === "code") {
            // Check there are no html/css macros at all on the Cloud page.
            let anyToConvert = false;
            for (const macroType of this.macroTypes) {
              const macroKey = `${macroType}Macros`;
              const dcMacros = entry[macroKey];
              if (!dcMacros || dcMacros.length === 0) continue;
              const cloudMacros = this.extractMacros(cloudStorageBody, macroType);
              if (cloudMacros.length > 0) {
                anyToConvert = true;
                break;
              }
            }
            allInSync = !anyToConvert;
          } else {
            // raw / macro mode: per-type ordinal content compare.
            allInSync = true;
            for (const macroType of this.macroTypes) {
              const macroKey = `${macroType}Macros`;
              const dcMacros = entry[macroKey];
              if (!dcMacros || dcMacros.length === 0) continue;

              const dcExtracted = this.extractMacros(page.body?.storage?.value, macroType);
              const cloudMacros = this.extractMacros(cloudStorageBody, macroType);

              if (!this._macrosAlreadyInSync(dcExtracted, cloudMacros)) {
                allInSync = false;
                break;
              }
            }
          }
        }

        if (allInSync) {
          this.stats.pagesAlreadyInSync++;
          this.log(`    Page "${pageTitle}" (DC: ${page.id}, Cloud: ${cloudPage.id}) - already in sync, skipping`);
          continue;
        }

        resolvedPages.push({ ...entry, cloudPage });
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, candidates.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Add resolved pages to plan
    let pagesPlanned = 0;
    for (const entry of resolvedPages) {
      const { page, htmlMacros, cssMacros, cloudPage } = entry;

      const planData = {
        spaceKey,
        title: page.title,
        cloudPageId: cloudPage.id,
        htmlMacros: htmlMacros.length > 0 ? htmlMacros : [],
        cssMacros: cssMacros.length > 0 ? cssMacros : [],
      };

      this.planManager.addPageToPlan(page.id, planData);
      pagesPlanned++;

      const macroSummary = [];
      if (htmlMacros.length > 0) macroSummary.push(`${htmlMacros.length} HTML`);
      if (cssMacros.length > 0) macroSummary.push(`${cssMacros.length} CSS`);
      this.log(`    Page "${page.title}" (DC: ${page.id}, Cloud: ${cloudPage.id}) - ${macroSummary.join(", ")} macro(s) planned`);

      if (this.limit > 0 && this.planManager.plan.stats.total >= this.limit) {
        break;
      }
    }

    this.log(`  Space ${spaceKey}: ${totalPagesFetched} pages scanned, ${pagesPlanned} with macros planned`);
    return pagesPlanned;
  }

  /**
   * Check if Cloud macros already match DC macros (content identical).
   * Used during plan phase to skip pages that don't need updating.
   *
   * @param {Array<{content: string}>} dcMacros - extracted DC macros
   * @param {Array<{content: string}>} cloudMacros - extracted Cloud macros
   * @returns {boolean} true if all macros match by ordinal position and content
   */
  _macrosAlreadyInSync(dcMacros, cloudMacros) {
    if (dcMacros.length !== cloudMacros.length) return false;
    if (dcMacros.length === 0) return true;

    for (let i = 0; i < dcMacros.length; i++) {
      // Normalize whitespace for comparison (storage format may differ slightly)
      const dcContent = dcMacros[i].content.trim();
      const cloudContent = cloudMacros[i].content.trim();
      if (dcContent !== cloudContent) return false;
    }

    return true;
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN
  // ─────────────────────────────────────────────────

  async executePlan() {
    const pagesToProcess = this.planManager.getPagesToProcess(this.retryFailed);

    if (pagesToProcess.length === 0) {
      this.log("  No pages to process.");
      const failedCount = this.planManager.plan?.stats?.failed || 0;
      if (!this.retryFailed && failedCount > 0) {
        this.log(`  (${failedCount} failed pages exist - use --retry-failed to reprocess them)`);
      }
      return;
    }

    this.log(`  Executing plan: ${pagesToProcess.length} pages to update...`);
    this.log(`  Concurrency: ${this.concurrency} parallel requests`);
    if (this.dryRun) {
      this.log("  *** DRY RUN MODE - No changes will be made ***");
    }
    this.log(`  Replacement mode: ${this.replacementMode}`);

    // Process with concurrency using worker pool
    let idx = 0;
    let processed = 0;

    const worker = async () => {
      while (idx < pagesToProcess.length) {
        const current = idx++;
        const [dcPageId, pageData] = pagesToProcess[current];

        await this._updateCloudPage(dcPageId, pageData);
        processed++;

        // Progress logging
        if (processed % 10 === 0 || processed === pagesToProcess.length) {
          this.log(`  Progress: ${processed}/${pagesToProcess.length} pages processed`);
        }

        // Periodic save
        if (processed % 50 === 0) {
          this.planManager.savePlan();
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, pagesToProcess.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Final save
    this.planManager.savePlan();
  }

  async _updateCloudPage(dcPageId, pageData) {
    const { cloudPageId, title, htmlMacros, cssMacros } = pageData;

    const hasHtml = htmlMacros && htmlMacros.length > 0;
    const hasCss = cssMacros && cssMacros.length > 0;

    if (!cloudPageId) {
      this.planManager.updatePageStatus(dcPageId, "skipped", "No Cloud page ID");
      this.stats.pagesSkipped++;
      return;
    }

    if (!hasHtml && !hasCss) {
      this.planManager.updatePageStatus(dcPageId, "skipped", "No macros to replace");
      this.stats.pagesSkipped++;
      return;
    }

    // Build summary for logging
    const macroSummary = [];
    if (hasHtml) macroSummary.push(`${htmlMacros.length} HTML`);
    if (hasCss) macroSummary.push(`${cssMacros.length} CSS`);
    const summaryStr = macroSummary.join(" + ");

    if (this.dryRun) {
      this.log(`    [DRY RUN] "${title}" (Cloud: ${cloudPageId}): Would replace ${summaryStr} macro(s)`);
      // IMPORTANT: do NOT mutate the plan in dry-run mode. Previously this
      // wrote status="completed", which polluted any pre-existing plan and
      // hid pages that had failed in a real run, blocking later --retry-failed.
      this.stats.pagesUpdated++;
      return;
    }

    try {
      // Fetch current Cloud page content
      const cloudPage = await this.cloudClient.getPageContent(cloudPageId);
      const cloudStorageBody = cloudPage.body?.storage?.value;
      const currentVersion = cloudPage.version?.number;
      const currentStatus = cloudPage.status || "current";
      const pageTitle = cloudPage.title || title;

      if (!cloudStorageBody) {
        this.planManager.updatePageStatus(dcPageId, "failed", "Cloud page has no storage body");
        this.stats.pagesFailed++;
        return;
      }

      if (!currentVersion) {
        this.planManager.updatePageStatus(dcPageId, "failed", "Could not determine Cloud page version");
        this.stats.pagesFailed++;
        return;
      }

      // Skip non-editable statuses (trashed/deleted/historical/draft).
      // The v2 PUT requires status="current" or matching the page's status,
      // and the latter usually fails for these. Mark skipped, not failed.
      if (currentStatus !== "current" && currentStatus !== "archived") {
        this.planManager.updatePageStatus(
          dcPageId,
          "skipped",
          `Cloud page status="${currentStatus}" — not updatable`,
        );
        this.stats.pagesSkipped++;
        return;
      }

      // Apply replacements for each macro type sequentially on the same body
      let newBody = cloudStorageBody;
      let totalReplacements = 0;

      if (hasHtml) {
        const result = this.replaceMacros(newBody, htmlMacros, this.replacementMode, "html");
        newBody = result.newBody;
        totalReplacements += result.replacementsMade;
      }

      if (hasCss) {
        const result = this.replaceMacros(newBody, cssMacros, this.replacementMode, "css");
        newBody = result.newBody;
        totalReplacements += result.replacementsMade;
      }

      if (totalReplacements === 0) {
        this.planManager.updatePageStatus(dcPageId, "skipped", "No replacements made (macros may already be fixed)");
        this.stats.pagesSkipped++;
        return;
      }

      // Check if content actually changed
      if (newBody === cloudStorageBody) {
        this.planManager.updatePageStatus(dcPageId, "skipped", "Content unchanged after replacement");
        this.stats.pagesSkipped++;
        return;
      }

      // Update Cloud page (pass through actual status from GET so v2 PUT
      // handles archived pages correctly).
      const result = await this.cloudClient.updatePageContent(
        cloudPageId,
        pageTitle,
        newBody,
        currentVersion,
        currentStatus,
      );

      if (result.success) {
        this.planManager.updatePageStatus(dcPageId, "completed");
        this.stats.pagesUpdated++;
        this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): ${summaryStr} macro(s) replaced`);
      } else {
        this.planManager.updatePageStatus(dcPageId, "failed", result.error);
        this.stats.pagesFailed++;
        this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): FAILED - ${result.error}`);
      }
    } catch (error) {
      this.planManager.updatePageStatus(dcPageId, "failed", error.message);
      this.stats.pagesFailed++;
      this.log(`    "${title}" (Cloud: ${cloudPageId}): ERROR - ${error.message}`);
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = HtmlMacroProcessor;
