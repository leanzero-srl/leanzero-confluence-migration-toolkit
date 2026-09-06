const fs = require("fs");
const path = require("path");

/**
 * VisibilityMacroProcessor (ADF flow)
 *
 * Visibility for Confluence (Show If / Hide If) macros migrated from DC
 * end up as legacy <ac:structured-macro ac:name="show-if"> in storage,
 * which Cloud no longer renders. The Cloud-native form is a Forge
 * "ecosystem" bodiedExtension. We:
 *
 *   1. CQL-search Cloud for pages still containing legacy macros.
 *   2. For each page, read the ADF body, look up the DC counterpart for
 *      the canonical group names, resolve names → Cloud groupIds.
 *   3. Convert each legacy bodiedExtension to a Forge ecosystem
 *      bodiedExtension with both fields populated:
 *        - macroParams.group.value      (raw names, kept for compat/UX)
 *        - guestParams.groupIds         (comma-separated UUIDs, what the
 *                                       editor reads to draw chips)
 *      Existing Forge macros on the page are also patched if they're
 *      missing guestParams.groupIds.
 *   4. PUT the page back via atlas_doc_format.
 *
 * Forge tenant template (extensionKey, extensionId, embeddedMacroContext)
 * is auto-discovered from the first page that has at least one already-
 * Forge show-if macro and cached in logs/forge_template.json.
 */
class VisibilityMacroProcessor {
  constructor(dcClient, cloudClient, planManager, resolver, options = {}) {
    this.dcClient = dcClient;
    this.cloudClient = cloudClient;
    this.planManager = planManager;
    this.resolver = resolver;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 3;
    this.spaceKeys = options.spaceKeys || [];
    this.scanAllSpaces = options.scanAllSpaces || false;
    this.retryFailed = options.retryFailed || false;
    this.macroNames = options.macroNames || ["show-if", "hide-if"];
    this.cacheDir = options.cacheDir || null;
    this.log = options.log || console.log;
    // Optional fallback: when a macro plans out with no group AND no user,
    // populate it with these groups instead. Pass as { names: "a,b", ids: "id1,id2" }.
    this.defaultGroupsFallback =
      options.defaultGroupsFallback &&
      options.defaultGroupsFallback.ids
        ? options.defaultGroupsFallback
        : null;
    // When true, if the DC page AND the corresponding DC macro are matched,
    // use DC's values exactly (no fallback to Cloud's current values). This
    // lets a previously-fallback-populated Cloud macro be cleared back to
    // match DC's empty state. Strict DC implicitly disables the
    // defaultGroupsFallback path so a revert run is not re-filled.
    this.strictDc = options.strictDc || false;
    if (this.strictDc) this.defaultGroupsFallback = null;

    this.templatePath = this.cacheDir
      ? path.join(this.cacheDir, "forge_template.json")
      : null;
    this.forgeTemplate = this._loadTemplate();

    this.stats = {
      spacesScanned: 0,
      cloudPagesFound: 0,
      pagesWithMacros: 0,
      pagesMatchedInDc: 0,
      pagesNotFoundInDc: 0,
      pagesUpdated: 0,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesUnresolved: 0,
      macrosTotal: 0,
      macrosLegacy: 0,
      macrosForge: 0,
      macrosResolved: 0,
      macrosUnresolved: 0,
      macrosDefaultedToFallback: 0,
      macrosSkippedScaffolding: 0,
    };
  }

  // The DC `show-if`/`hide-if` macro NAMES are shared between the
  // Visibility-for-Confluence app (group/users restriction) and the
  // Scaffolding Forms & Templates app (action=edit/view, match=, etc.).
  // We must NOT convert a scaffolding-style macro to a Forge visibility
  // ecosystem extension — the conversion wipes its scaffolding semantics.
  // Discriminator: presence of any visibility-style param. If DC has
  // params and none of them are visibility-style, treat as scaffolding.
  static get VISIBILITY_PARAMS() {
    return new Set(["group", "groups", "user-groups", "users", "user"]);
  }
  static get SCAFFOLDING_PARAMS() {
    return new Set([
      "action",
      "match",
      "currentSpace",
      "spacePermission",
      "label",
      "atlassian-macro-output-type",
    ]);
  }
  _classifyDcMacro(dc) {
    if (!dc || !dc.params) return "unknown";
    const keys = Object.keys(dc.params);
    if (keys.length === 0) return "unknown";
    const VIS = VisibilityMacroProcessor.VISIBILITY_PARAMS;
    const SCAFF = VisibilityMacroProcessor.SCAFFOLDING_PARAMS;
    const hasVis = keys.some((k) => VIS.has(k));
    if (hasVis) return "visibility";
    const hasScaff = keys.some((k) => SCAFF.has(k));
    if (hasScaff) return "scaffolding";
    // Has params but neither visibility nor known-scaffolding — be safe and
    // skip rather than risk wiping unknown semantics.
    return "scaffolding";
  }

  // ─────────────────────────────────────────────────────────────────
  //  TEMPLATE PERSISTENCE
  // ─────────────────────────────────────────────────────────────────

  _loadTemplate() {
    if (!this.templatePath || !fs.existsSync(this.templatePath)) return null;
    try {
      const t = JSON.parse(fs.readFileSync(this.templatePath, "utf8"));
      this.log(`  [Template] Loaded Forge template from ${this.templatePath}`);
      return t;
    } catch (e) {
      this.log(`  [Template] Could not load template: ${e.message}`);
      return null;
    }
  }

  _saveTemplate() {
    if (!this.templatePath || !this.forgeTemplate) return;
    try {
      fs.writeFileSync(
        this.templatePath,
        JSON.stringify(this.forgeTemplate, null, 2),
      );
      this.log(`  [Template] Saved Forge template to ${this.templatePath}`);
    } catch (e) {
      this.log(`  [Template] Could not save template: ${e.message}`);
    }
  }

  /**
   * Extract a tenant-wide template from a Forge ecosystem show-if node.
   * The extensionKey/extensionId are tenant-stable; embeddedMacroContext
   * is borrowed (its accountId/cloudId/contextIds also tenant-stable).
   */
  _captureTemplate(forgeNode) {
    const a = forgeNode.attrs;
    const p = a.parameters || {};
    this.forgeTemplate = {
      extensionKey: a.extensionKey,
      extensionType: a.extensionType,
      text: a.text || "Visibility - Show if",
      extensionTitle: a.extensionTitle || "Visibility - Show if",
      extensionId: p.extensionId,
      forgeEnvironment: p.forgeEnvironment || "PRODUCTION",
      embeddedMacroContext: p.embeddedMacroContext,
    };
    this._saveTemplate();
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADF WALK / EXTRACTION
  // ─────────────────────────────────────────────────────────────────

  /**
   * Walk an ADF document, returning every show-if/hide-if bodiedExtension
   * with metadata about its flavor.
   *
   * @returns {Array<{node, parent, indexInParent, flavor, macroName}>}
   *   flavor = "legacy" | "forge"
   */
  collectVisibilityNodes(adf) {
    const out = [];
    const allowed = new Set(this.macroNames);
    const walk = (node, parent, idx) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "bodiedExtension" && node.attrs) {
        const ek = node.attrs.extensionKey || "";
        const et = node.attrs.extensionType || "";
        // Forge-style key: "<appId>/<envId>/static/show-if"
        // Legacy-style key: "show-if"
        let macroName = null;
        if (allowed.has(ek)) macroName = ek;
        else {
          const tail = ek.includes("/") ? ek.substring(ek.lastIndexOf("/") + 1) : null;
          if (tail && allowed.has(tail)) macroName = tail;
        }
        if (macroName) {
          const flavor = et === "com.atlassian.ecosystem" ? "forge" : "legacy";
          out.push({ node, parent, indexInParent: idx, flavor, macroName });
        }
      }
      if (Array.isArray(node.content)) {
        node.content.forEach((c, i) => walk(c, node, i));
      }
    };
    walk(adf, null, -1);
    return out;
  }

  /**
   * Extract the equivalent of the "group" parameter from any show-if node,
   * returning a comma-separated NAME string (post-trim, "" if empty).
   * Looks first at macroParams (canonical), then guestParams (UI mirror).
   */
  extractGroupNames(node) {
    const p = node.attrs.parameters || {};
    return (
      this._readParamValue(p.macroParams?.group) ||
      this._readParamValue(p.guestParams?.group) ||
      ""
    );
  }

  extractUserNames(node) {
    const p = node.attrs.parameters || {};
    return (
      this._readParamValue(p.macroParams?.users) ||
      this._readParamValue(p.guestParams?.users) ||
      ""
    );
  }

  // ADF param values may be either a bare string or { value: string }.
  // An empty string in `.value` is a real signal ("no restriction") and must
  // not silently fall through to stringifying the wrapper object — that
  // produced "[object Object]" and poisoned downstream resolution.
  _readParamValue(p) {
    if (p == null) return "";
    if (typeof p === "string") return p;
    if (typeof p === "object" && "value" in p) {
      return typeof p.value === "string" ? p.value : "";
    }
    return "";
  }

  // Walk DC storage and extract every show-if/hide-if structured macro,
  // including ones nested inside other macros (e.g. inside expand,
  // section, or another show-if). Each entry carries ac:macro-id when
  // present so the planner can match by ID rather than ordinal.
  extractDcParamsFromStorage(storageBody) {
    if (!storageBody) return [];
    const macros = [];
    const allowed = new Set(this.macroNames);
    const openTag = /<ac:structured-macro\b([^>]*)>/g;
    const closeTagStr = "</ac:structured-macro>";
    let match;
    while ((match = openTag.exec(storageBody)) !== null) {
      const attrs = match[1];
      const nameMatch = attrs.match(/ac:name\s*=\s*"([^"]+)"/);
      if (!nameMatch || !allowed.has(nameMatch[1])) continue;
      const macroName = nameMatch[1];
      const idMatch = attrs.match(/ac:macro-id\s*=\s*"([^"]+)"/);
      const macroId = idMatch ? idMatch[1] : null;

      // Walk forward tracking depth to find this macro's matching close tag.
      // Self-closed macros `<ac:structured-macro ... />` open and close in
      // one tag and must NOT bump depth — historically this caused depth
      // to ratchet up forever and the macro to be silently skipped.
      const start = match.index;
      let depth = 1;
      let cursor = openTag.lastIndex;
      let endPos = -1;
      while (depth > 0) {
        const nextOpen = storageBody.indexOf("<ac:structured-macro", cursor);
        const nextClose = storageBody.indexOf(closeTagStr, cursor);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          const tagEnd = storageBody.indexOf(">", nextOpen);
          if (tagEnd === -1) break;
          const isSelfClose = storageBody[tagEnd - 1] === "/";
          if (!isSelfClose) depth++;
          cursor = tagEnd + 1;
        } else {
          depth--;
          cursor = nextClose + closeTagStr.length;
          if (depth === 0) endPos = cursor;
        }
      }
      if (endPos === -1) continue;

      macros.push({
        index: macros.length,
        macroName,
        macroId,
        params: this._parseTopLevelParams(storageBody.substring(start, endPos)),
      });
      // Intentionally leave openTag.lastIndex past the opening tag (not
      // past endPos): subsequent exec() calls will then discover any
      // nested allowed macros as their own entries.
    }
    return macros;
  }

  _parseTopLevelParams(macroXml) {
    const params = {};
    const innerStart = macroXml.indexOf(">") + 1;
    const innerEnd = macroXml.lastIndexOf("</ac:structured-macro>");
    if (innerStart <= 0 || innerEnd <= innerStart) return params;
    const inner = macroXml.substring(innerStart, innerEnd);

    // Open-tag must NOT be self-closing: `[^>]*?(?<!\/)>` rejects `<ac:parameter
    // ac:name="X"/>` because `/` precedes the `>`. Without this guard, the
    // regex would greedily span across a self-closed parameter and capture
    // the next `<ac:parameter ac:name="...">VALUE</ac:parameter>` whole as
    // the previous parameter's value (observed: currentSpace="<ac:parameter ac:name=\"action\">view").
    const paramRe = /<ac:parameter\b([^>]*?)(?<!\/)>([\s\S]*?)<\/ac:parameter>/g;
    let depth = 0;
    let pos = 0;
    while (pos < inner.length) {
      const nextOpen = inner.indexOf("<ac:structured-macro", pos);
      if (depth === 0) {
        const segEnd = nextOpen === -1 ? inner.length : nextOpen;
        const segment = inner.substring(pos, segEnd);
        paramRe.lastIndex = 0;
        let m;
        while ((m = paramRe.exec(segment)) !== null) {
          const nameMatch = m[1].match(/ac:name\s*=\s*"([^"]+)"/);
          if (!nameMatch) continue;
          params[nameMatch[1]] = m[2];
        }
        if (nextOpen === -1) break;
        // Self-closed nested macro: skip past its `/>` without bumping depth.
        const tagEnd = inner.indexOf(">", nextOpen);
        if (tagEnd === -1) break;
        const isSelfClose = inner[tagEnd - 1] === "/";
        if (isSelfClose) {
          pos = tagEnd + 1;
        } else {
          depth = 1;
          pos = tagEnd + 1;
        }
      } else {
        const nextClose = inner.indexOf("</ac:structured-macro>", pos);
        if (nextClose === -1) break;
        const inMore = inner.indexOf("<ac:structured-macro", pos);
        if (inMore !== -1 && inMore < nextClose) {
          const tagEnd = inner.indexOf(">", inMore);
          if (tagEnd === -1) break;
          const isSelfClose = inner[tagEnd - 1] === "/";
          if (!isSelfClose) depth++;
          pos = tagEnd + 1;
        } else {
          depth--;
          pos = nextClose + "</ac:structured-macro>".length;
        }
      }
    }
    return params;
  }

  // ─────────────────────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────────────────────

  async buildPlan(runId) {
    this.planManager.createPlan(runId);

    let spaces;
    if (this.spaceKeys.length > 0) {
      spaces = this.spaceKeys.map((key) => ({ key, name: key }));
      this.log(`\nScanning ${spaces.length} specified space(s): ${this.spaceKeys.join(", ")}`);
    } else if (this.scanAllSpaces) {
      this.log("\nScanning ALL spaces (per --all flag)");
      spaces = [{ key: null, name: "<all>" }];
    } else {
      throw new Error("No spaces specified. Use --space KEY or --all.");
    }

    this.log(`  Macro names: ${this.macroNames.join(", ")}`);
    if (this.forgeTemplate) {
      this.log(`  Forge template: cached (extensionKey=${this.forgeTemplate.extensionKey})`);
    } else {
      this.log(`  Forge template: not yet discovered (will pick up first one we see)`);
    }

    let totalPlanned = 0;
    for (let i = 0; i < spaces.length; i++) {
      const space = spaces[i];
      const label = space.key || "<all>";
      this.log(`\n[${i + 1}/${spaces.length}] Scanning space: ${label}`);
      try {
        const count = await this._scanSpace(space.key);
        totalPlanned += count;
        this.stats.spacesScanned++;
      } catch (err) {
        this.log(`  ERROR scanning space ${label}: ${err.message}`);
        if (err.stack) this.log(`  ${err.stack}`);
        continue;
      }
      if (this.limit > 0 && totalPlanned >= this.limit) {
        this.log(`\n  Reached limit ${this.limit}, stopping scan.`);
        break;
      }
    }

    this.planManager.savePlan();
    this.log(`\nPlan built. File: ${this.planManager.planFilePath}`);
    this.log(`  ${this.planManager.formatStats()}`);
    return this.planManager.plan;
  }

  async _scanSpace(spaceKey) {
    const macroQuoted = this.macroNames.map((n) => `"${n}"`).join(",");
    const cqlBase = spaceKey
      ? `space = "${spaceKey}" AND macro in (${macroQuoted}) AND type = page`
      : `macro in (${macroQuoted}) AND type = page`;

    const candidates = [];
    let limitReached = false;

    await this.cloudClient.searchContentByCql(
      cqlBase,
      "version,space",
      async (results) => {
        if (limitReached) return false;
        for (const page of results) {
          this.stats.cloudPagesFound++;
          candidates.push(page);
          if (this.limit > 0 && (this.planManager.plan.stats.total + candidates.length) >= this.limit) {
            limitReached = true;
            break;
          }
        }
        if (limitReached) return false;
      },
    );

    if (candidates.length === 0) {
      this.log(`  No Cloud pages with visibility macros found in ${spaceKey || "<all>"}`);
      return 0;
    }

    let idx = 0;
    let plannedCount = 0;

    const worker = async () => {
      while (idx < candidates.length) {
        const cur = idx++;
        const cloudPage = candidates[cur];
        try {
          const planned = await this._planCloudPage(cloudPage);
          if (planned) plannedCount++;
        } catch (e) {
          this.log(`  ERROR planning page "${cloudPage.title}" (${cloudPage.id}): ${e.message}`);
        }
        if (this.limit > 0 && this.planManager.plan.stats.total >= this.limit) break;
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, candidates.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    this.log(`  Space ${spaceKey || "<all>"}: ${candidates.length} candidate Cloud pages, ${plannedCount} planned`);
    return plannedCount;
  }

  async _planCloudPage(cloudPage) {
    const cloudPageId = cloudPage.id;
    const title = cloudPage.title;
    const spaceKey = cloudPage.space?.key;

    // Fetch ADF
    let pageWithAdf;
    try {
      pageWithAdf = await this.cloudClient.getPageAdf(cloudPageId);
    } catch (e) {
      this.log(`    "${title}" (${cloudPageId}): ADF fetch failed: ${e.message}`);
      return false;
    }
    const adfRaw = pageWithAdf.body?.atlas_doc_format?.value;
    if (!adfRaw) {
      this.log(`    "${title}" (${cloudPageId}): no ADF body, skipping`);
      return false;
    }
    let adf;
    try {
      adf = JSON.parse(adfRaw);
    } catch (e) {
      this.log(`    "${title}" (${cloudPageId}): ADF parse failed: ${e.message}`);
      return false;
    }

    const nodes = this.collectVisibilityNodes(adf);
    if (nodes.length === 0) {
      this.log(`    "${title}" (${cloudPageId}): CQL matched but ADF has no show-if/hide-if nodes; skipping`);
      return false;
    }

    this.stats.pagesWithMacros++;

    // Capture template if we don't have one yet and this page has a Forge node
    if (!this.forgeTemplate) {
      const forgeNode = nodes.find((n) => n.flavor === "forge");
      if (forgeNode) {
        this._captureTemplate(forgeNode.node);
        this.log(`    Captured Forge template from "${title}" (${cloudPageId})`);
      }
    }

    // DC lookup for source-of-truth NAMES
    let dcMacros = [];
    let dcPageId = null;
    if (spaceKey) {
      const cql = `space = "${spaceKey}" AND title = "${title.replace(/"/g, '\\"')}" AND type = page`;
      try {
        await this.dcClient.searchContentByCql(cql, "body.storage", async (results) => {
          if (results.length > 0) {
            dcPageId = results[0].id;
            dcMacros = this.extractDcParamsFromStorage(results[0].body?.storage?.value || "");
            return false;
          }
        });
      } catch (e) {
        this.log(`    "${title}" (${cloudPageId}): DC lookup error: ${e.message}`);
      }
    }
    if (dcPageId) this.stats.pagesMatchedInDc++;
    else this.stats.pagesNotFoundInDc++;

    // Build per-macro plan entries (key by macroId for stable execute lookups)
    const planMacros = [];
    let pageHasChange = false;

    // Index DC macros by ac:macro-id so we can match Cloud ADF macros
    // structurally instead of by ordinal position. Ordinal alignment
    // breaks whenever Cloud ADF and DC storage iterate macros in
    // different orders (e.g. nested inside other macros).
    const dcById = new Map();
    for (const m of dcMacros) {
      if (m.macroId) dcById.set(m.macroId, m);
    }

    for (let i = 0; i < nodes.length; i++) {
      const entry = nodes[i];
      this.stats.macrosTotal++;
      if (entry.flavor === "legacy") this.stats.macrosLegacy++;
      else this.stats.macrosForge++;

      const cloudGroupNames = this.extractGroupNames(entry.node);
      const cloudUserNames = this.extractUserNames(entry.node);
      const cloudMacroId =
        entry.node.attrs?.parameters?.macroMetadata?.macroId?.value || null;
      const dc =
        (cloudMacroId && dcById.get(cloudMacroId)) || dcMacros[i] || null;

      // SCAFFOLDING-AWARE FILTER. The `show-if`/`hide-if` macro names are
      // shared between Visibility-for-Confluence (group/users) and
      // Scaffolding Forms & Templates (action=edit/view, match=...). If DC
      // says this is a scaffolding-style instance, do NOT rewrite the Cloud
      // node — `_applyForgeAttrs` would replace its attrs wholesale and wipe
      // the scaffolding semantics. Skip the macro and continue.
      const dcKind = this._classifyDcMacro(dc);
      if (dcKind === "scaffolding") {
        this.stats.macrosSkippedScaffolding++;
        continue;
      }

      const dcGroupNames = dc?.params?.group || dc?.params?.groups || dc?.params?.["user-groups"] || "";
      const dcUserNames = dc?.params?.users || dc?.params?.user || "";

      // Source-of-truth. Default mode: prefer DC if present, otherwise fall
      // back to Cloud's existing names (keeps the page untouched if DC is
      // missing that value).
      // Strict-DC mode: when the DC macro was matched (`dc != null`), trust
      // DC exactly — including an explicit empty string, which means "clear
      // Cloud". We only fall back to Cloud when DC itself was not matched.
      const trustDcExactly = this.strictDc && dc != null;
      const sourceGroupNames = trustDcExactly
        ? (dcGroupNames || "").trim()
        : (dcGroupNames || cloudGroupNames || "").trim();
      const sourceUserNames = trustDcExactly
        ? (dcUserNames || "").trim()
        : (dcUserNames || cloudUserNames || "").trim();

      const groupResolution = await this.resolver.resolveList(sourceGroupNames, "group");
      const userResolution = await this.resolver.resolveList(sourceUserNames, "user");

      let appliedGroupNames = sourceGroupNames;
      let appliedGroupIds = groupResolution.ids;
      let defaultedToFallback = false;
      if (
        this.defaultGroupsFallback &&
        !groupResolution.ids &&
        !userResolution.ids &&
        groupResolution.unresolved.length === 0 &&
        userResolution.unresolved.length === 0
      ) {
        appliedGroupNames = this.defaultGroupsFallback.names || "";
        appliedGroupIds = this.defaultGroupsFallback.ids;
        defaultedToFallback = true;
        this.stats.macrosDefaultedToFallback++;
      }

      const macroId =
        entry.node.attrs?.parameters?.macroMetadata?.macroId?.value ||
        entry.node.attrs?.localId ||
        `idx-${i}`;

      const currentGuestGroupIds =
        entry.node.attrs?.parameters?.guestParams?.groupIds || "";
      const currentGuestUsers =
        entry.node.attrs?.parameters?.guestParams?.users || "";

      const planEntry = {
        index: i,
        macroId,
        macroName: entry.macroName,
        flavor: entry.flavor,
        sourceGroupNames: appliedGroupNames,
        sourceUserNames,
        groupIds: appliedGroupIds,
        users: userResolution.ids,
        unresolvedGroups: groupResolution.unresolved,
        unresolvedUsers: userResolution.unresolved,
        ...(defaultedToFallback ? { defaultedToFallback: true } : {}),
      };

      const hasUnresolved =
        planEntry.unresolvedGroups.length > 0 || planEntry.unresolvedUsers.length > 0;
      if (hasUnresolved) this.stats.macrosUnresolved++;
      else this.stats.macrosResolved++;

      // Determine if this macro requires writing
      const needsConvert = entry.flavor === "legacy";
      const groupIdsDiffer = planEntry.groupIds !== currentGuestGroupIds;
      const usersDiffer = planEntry.users !== currentGuestUsers;
      if (needsConvert || groupIdsDiffer || usersDiffer) pageHasChange = true;

      planMacros.push(planEntry);
    }

    if (!pageHasChange) {
      this.log(`    "${title}" (Cloud: ${cloudPageId}): already in sync, skipping`);
      return false;
    }

    this.planManager.addPageToPlan(cloudPageId, {
      spaceKey,
      title,
      cloudPageId,
      dcPageId,
      contentType: cloudPage.type || "page",
      macros: planMacros,
    });

    const summary = planMacros
      .map(
        (m) =>
          `${m.flavor === "legacy" ? "L" : "F"}:${m.macroName}[g=${m.groupIds ? m.groupIds.split(",").length : 0}/u=${m.users ? m.users.split(",").length : 0}${m.unresolvedGroups.length || m.unresolvedUsers.length ? ` UNRES(g=${m.unresolvedGroups.length},u=${m.unresolvedUsers.length})` : ""}]`,
      )
      .join(", ");
    this.log(`    "${title}" (Cloud: ${cloudPageId}, DC: ${dcPageId || "n/a"}): ${summary}`);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  //  PHASE 2: EXECUTE
  // ─────────────────────────────────────────────────────────────────

  async executePlan() {
    const pages = this.planManager.getPagesToProcess(this.retryFailed);
    if (pages.length === 0) {
      this.log("  No pages to process.");
      return;
    }
    if (!this.forgeTemplate) {
      throw new Error(
        "No Forge template available. Need at least one Forge show-if macro on a page in the tenant. Run a planning pass first to discover one, or convert one macro manually.",
      );
    }
    this.log(`  Executing plan: ${pages.length} pages`);
    this.log(`  Concurrency: ${this.concurrency}`);
    if (this.dryRun) this.log("  *** DRY RUN MODE - No changes will be made ***");

    let idx = 0;
    let processed = 0;

    const worker = async () => {
      while (idx < pages.length) {
        const cur = idx++;
        const [cloudPageId, data] = pages[cur];
        await this._executePage(cloudPageId, data);
        processed++;
        if (processed % 10 === 0 || processed === pages.length) {
          this.log(`  Progress: ${processed}/${pages.length}`);
        }
        if (processed % 50 === 0) this.planManager.savePlan();
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, pages.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    this.planManager.savePlan();
  }

  async _executePage(cloudPageId, data) {
    const { title, macros } = data;

    if (!macros || macros.length === 0) {
      this.planManager.updatePageStatus(cloudPageId, "skipped", "No macros");
      this.stats.pagesSkipped++;
      return;
    }

    if (this.dryRun) {
      this.log(`    [DRY RUN] "${title}" (Cloud: ${cloudPageId}): would update ${macros.length} macro(s)`);
      this.planManager.updatePageStatus(cloudPageId, "completed");
      this.stats.pagesUpdated++;
      return;
    }

    try {
      const page = await this.cloudClient.getPageAdf(cloudPageId);
      const adfRaw = page.body?.atlas_doc_format?.value;
      const version = page.version?.number;
      const pageTitle = page.title || title;
      const pageType = page.type || data.contentType || "page";
      if (!adfRaw || !version) {
        this.planManager.updatePageStatus(cloudPageId, "failed", "Missing Cloud ADF or version");
        this.stats.pagesFailed++;
        return;
      }
      const adf = JSON.parse(adfRaw);
      const liveNodes = this.collectVisibilityNodes(adf);

      // Build a lookup by macroId (stable across edits) and by ordinal as fallback
      const liveById = new Map();
      liveNodes.forEach((entry) => {
        const mid = entry.node.attrs?.parameters?.macroMetadata?.macroId?.value;
        if (mid) liveById.set(mid, entry);
      });

      let mutations = 0;
      let skippedUnresolved = 0;

      for (let i = 0; i < macros.length; i++) {
        const planned = macros[i];
        const hasUnresolved =
          planned.unresolvedGroups.length > 0 || planned.unresolvedUsers.length > 0;
        if (hasUnresolved) {
          skippedUnresolved++;
          continue;
        }

        let entry = liveById.get(planned.macroId) || liveNodes[i] || null;
        if (!entry) continue;

        const before = JSON.stringify(entry.node.attrs);
        this._applyForgeAttrs(entry.node, planned, cloudPageId, page.space?.id, page.space?.key, version, pageType);
        const after = JSON.stringify(entry.node.attrs);
        if (before !== after) mutations++;
      }

      if (mutations === 0) {
        const status = skippedUnresolved > 0 ? "unresolved" : "skipped";
        const reason = skippedUnresolved > 0 ? "All target macros have unresolved names" : "Nothing changed";
        this.planManager.updatePageStatus(cloudPageId, status, reason);
        if (status === "unresolved") this.stats.pagesUnresolved++;
        else this.stats.pagesSkipped++;
        return;
      }

      const result = await this.cloudClient.updatePageAdf(
        cloudPageId,
        pageTitle,
        pageType,
        adf,
        version,
      );
      if (result.success) {
        this.planManager.updatePageStatus(cloudPageId, "completed");
        this.stats.pagesUpdated++;
        const note = skippedUnresolved > 0 ? ` (left ${skippedUnresolved} macro(s) untouched: unresolved names)` : "";
        this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): ${mutations} macro(s) updated${note}`);
      } else {
        this.planManager.updatePageStatus(cloudPageId, "failed", result.error);
        this.stats.pagesFailed++;
        this.log(`    "${pageTitle}" (Cloud: ${cloudPageId}): FAILED - ${result.error}`);
      }
    } catch (e) {
      this.planManager.updatePageStatus(cloudPageId, "failed", e.message);
      this.stats.pagesFailed++;
      this.log(`    "${title}" (Cloud: ${cloudPageId}): ERROR - ${e.message}`);
    }
  }

  /**
   * Mutate a bodiedExtension's attrs to be a properly-shaped Forge
   * ecosystem show-if node populated with the planned IDs and names.
   * Preserves the existing macroId / localId so the body content stays
   * tied to the right macro.
   */
  _applyForgeAttrs(node, planned, cloudPageId, spaceId, spaceKey, pageVersion, pageType) {
    const t = this.forgeTemplate;
    const existing = node.attrs || {};
    const existingParams = existing.parameters || {};
    const existingMid =
      existingParams.macroMetadata?.macroId?.value || existing.localId || planned.macroId;
    const existingLocalId = existing.localId || existingMid;
    const existingLayout = existing.layout || "default";
    const existingMeasured = existingParams.measuredHeight;

    // Preserve a per-page embeddedMacroContext where possible
    const ctx = JSON.parse(JSON.stringify(t.embeddedMacroContext || {}));
    if (ctx.extensionData) {
      ctx.extensionData.content = {
        id: String(cloudPageId),
        type: pageType || "page",
        version: pageVersion,
      };
      if (spaceKey || spaceId) {
        ctx.extensionData.space = {
          id: spaceId ? String(spaceId) : (ctx.extensionData.space?.id || ""),
          key: spaceKey || ctx.extensionData.space?.key || "",
        };
      }
    }

    const groupNames = planned.sourceGroupNames || "";
    const groupIds = planned.groupIds || "";
    const users = planned.users || "";

    const newParameters = {
      layout: "bodiedExtension",
      guestParams: {
        groupIds,
        cwStatus: existingParams.guestParams?.cwStatus ?? "",
        users,
        matchUsing: existingParams.guestParams?.matchUsing || "any",
      },
      forgeEnvironment: t.forgeEnvironment || "PRODUCTION",
      ...(existingMeasured !== undefined ? { measuredHeight: existingMeasured } : {}),
      macroParams: {
        group: { value: groupNames },
      },
      embeddedMacroContext: ctx,
      macroMetadata: {
        macroId: { value: existingMid },
        schemaVersion: { value: "1" },
        title: planned.macroName || "show-if",
      },
      extensionId: t.extensionId,
      localId: existingLocalId,
      render: "native",
      extensionTitle: t.extensionTitle || "Visibility - Show if",
    };

    node.attrs = {
      layout: existingLayout,
      extensionType: "com.atlassian.ecosystem",
      extensionKey: t.extensionKey,
      text: t.text || "Visibility - Show if",
      parameters: newParameters,
      localId: existingLocalId,
    };
  }

  /**
   * Inverse of _applyForgeAttrs: rewrite a Forge-ecosystem visibility
   * bodiedExtension back to its original legacy storage-bodied form using
   * DC-extracted params. Used to recover scaffolding macros that were
   * incorrectly converted to Visibility-for-Confluence Forge extensions.
   *
   * - Preserves node.content (the bodied children).
   * - Preserves the existing localId so the bodied tree stays anchored.
   * - Restores `extensionType: com.atlassian.confluence.macro.core` and
   *   `extensionKey: <show-if|hide-if>` exactly as Cloud's storage-format
   *   round-trip produces for legacy bodied macros.
   * - Repacks DC params into `macroParams.<name>.value`.
   *
   * @param {object} node - The Cloud bodiedExtension node to mutate
   * @param {object} dcMacro - { macroName, macroId, params: {k:v,...} }
   */
  _applyLegacyAttrs(node, dcMacro) {
    const existing = node.attrs || {};
    const existingParams = existing.parameters || {};
    const existingMid =
      existingParams.macroMetadata?.macroId?.value || existing.localId || null;
    // DC's ac:macro-id is the source-of-truth when present; otherwise keep
    // whatever Cloud currently has so we don't insert `null` into ADF.
    const macroId = dcMacro.macroId || existingMid || dcMacro.planMacroId || `restore-${Date.now()}`;
    const existingLocalId = existing.localId || macroId;
    const existingLayout = existing.layout || "default";

    const macroParams = {};
    for (const [k, v] of Object.entries(dcMacro.params || {})) {
      macroParams[k] = { value: typeof v === "string" ? v : "" };
    }

    node.attrs = {
      layout: existingLayout,
      extensionType: "com.atlassian.confluence.macro.core",
      extensionKey: dcMacro.macroName,
      parameters: {
        macroParams,
        macroMetadata: {
          macroId: { value: macroId },
          schemaVersion: { value: "1" },
          title: dcMacro.macroName,
        },
      },
      localId: existingLocalId,
    };
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = VisibilityMacroProcessor;
