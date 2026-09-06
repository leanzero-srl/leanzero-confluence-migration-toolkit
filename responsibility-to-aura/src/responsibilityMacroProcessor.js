"use strict";

const crypto = require("crypto");

/**
 * responsibilityMacroProcessor.js
 *
 * Splice-rewrite engine for converting Linchpin "Content Responsibility"
 * macros (Server/DC-only app by //SEIBERT/MEDIA) to "Aura User Profile"
 * macros (Cloud Forge app by Aura Apps / Seibert / appanvil) in
 * Confluence Cloud storage XHTML.
 *
 * After DC -> Cloud migration the Responsibility macro is preserved
 * verbatim in storage but rendered as an "Unknown macro" placeholder in
 * Cloud (because the Linchpin app isn't installed). The XML stays
 * discoverable via CQL `macro = "<name>"` and editable via the v1 PUT
 * /rest/api/content/{id} storage endpoint.
 *
 * Approach mirrors confluence/composition-tabs:
 *   - regex + depth-aware string walk (no XML parser; preserves
 *     byte-for-byte everything we don't intentionally change)
 *   - back-to-front splice so earlier rewrites don't shift later spans
 *
 * This module is pure string manipulation. No network. The entry script
 * is responsible for fetching pages, looking up user accountIds via the
 * IdentityResolver, saving backups, and PUTting via CloudConfluenceClient.
 *
 * Public surface:
 *   processor.findCandidateMacros(storageXml)
 *     -> [{ name, macroId, params, paramSpans, span, headerEnd, selfClose, schemaVersion }]
 *   processor.extractUserTokens(instance)
 *     -> string[] — raw tokens from the users param (userkey, accountId, username, or plain CSV)
 *   processor.buildAuraReplacement(accountIds, opts?)
 *     -> string — replacement XHTML, chunked into ceil(N/MAX_USERS_PER_AURA) macros
 *   processor.rewriteStorage(storageXml, instances, accountIdsByMacroKey)
 *     -> { newXml, changes, skipped, lossyParamDrops }
 *   processor.unifiedDiff(oldXml, newXml, contextLines?)
 *     -> string
 */

const STRUCT_OPEN = "<ac:structured-macro";
const STRUCT_CLOSE = "</ac:structured-macro>";
const STRUCT_CLOSE_LEN = STRUCT_CLOSE.length;

class ResponsibilityMacroProcessor {
  /**
   * @param {object} options
   * @param {string[]} [options.sourceMacroNames]
   *   Candidate `ac:name` values for the Linchpin macro. Exact name is
   *   undocumented and must be confirmed empirically from a real DC page;
   *   defaults are best-effort guesses based on Atlassian plugin naming
   *   conventions. Confirm via `--discovery-dump`.
   * @param {string} [options.sourceUsersParam="users"]
   *   Name of the parameter on the source macro that carries users.
   * @param {string[]} [options.lossyParams]
   *   Source parameters that have no Aura equivalent. Their values are
   *   captured and reported via lossyParamDrops; the params are dropped
   *   from the output.
   * @param {string} [options.targetMacroName="aura-user-profile"]
   *   `ac:name` of the Aura macro to emit. Confirm empirically.
   * @param {string} [options.targetUsersParam="users"]
   *   Parameter name on the Aura macro that accepts the comma-separated
   *   accountId list. Confirm empirically.
   * @param {number} [options.targetSchemaVersion=1]
   * @param {number} [options.maxUsersPerAura=10]
   * @param {string} [options.targetUserSeparator=","]
   *   Separator between accountIds inside the target users param.
   * @param {boolean} [options.targetUsersUseRiUser=false]
   *   When true, emit `<ri:user ri:account-id="..."/>` tags inside the
   *   users param instead of comma-separated accountId strings.
   * @param {Function} [options.log=console.log]
   */
  constructor(options = {}) {
    this.log = options.log || console.log;

    this.sourceMacroNames = (options.sourceMacroNames && options.sourceMacroNames.length)
      ? options.sourceMacroNames.map(String)
      // Empirically confirmed from a real Cloud page (post-DC-migration):
      // the Linchpin "Content Responsibility" macro lands as ac:name="responsible-person-macro".
      : ["responsible-person-macro"];
    this._sourceNameSet = new Set(this.sourceMacroNames);

    this.sourceUsersParam = options.sourceUsersParam || "users";

    // The Linchpin macro doesn't carry users inline — only `profile_field_identifier`
    // (the profile-field key to display under each user, e.g. "confluence.position").
    // We map this to Aura's per-card `info` field via `profileFieldToInfoMap`.
    this.sourceProfileFieldParam = options.sourceProfileFieldParam || "profile_field_identifier";
    this.profileFieldToInfoMap = options.profileFieldToInfoMap || {
      "confluence.position": "Role Title",
      "confluence.department": "Department",
      "confluence.email": "Email",
      "confluence.phone": "Phone",
      "confluence.location": "Location",
    };
    this.defaultInfoLabel = options.defaultInfoLabel || "Role Title";

    this.lossyParams = (options.lossyParams && options.lossyParams.length)
      ? options.lossyParams.map(String)
      : [
          "additionalInformation", "additional-information",
          "width", "macroWidth", "macro-width",
          "element_width", "elementWidth", "element-width",
        ];

    this.targetMacroName = options.targetMacroName || "aura-user-profile";
    this.targetSchemaVersion = options.targetSchemaVersion || 1;
    this.maxUsersPerAura = options.maxUsersPerAura || 10;

    // Output mode:
    //   "simple" (default) — legacy: one ac:parameter "users" with CSV accountIds.
    //                        Used by unit tests; never the real Aura wire format.
    //   "rich"             — real Aura User Profile macro: ac:parameter "summary" +
    //                        ac:parameter "params" (base64(urlencode(JSON))) with cards[].
    this.auraOutputMode = options.auraOutputMode === "rich" ? "rich" : "simple";

    // Simple-mode tunables (legacy / tests)
    this.targetUsersParam = options.targetUsersParam || "users";
    this.targetUserSeparator = options.targetUserSeparator || ",";
    this.targetUsersUseRiUser = options.targetUsersUseRiUser === true;

    // Rich-mode tunables (real Aura output). Defaults mirror the sample
    // XML the user provided; override via constructor options as needed.
    this.auraCardDefaults = Object.assign(
      {
        cardSize: "small",
        cardStyle: "diagonal",
        hover: "none",
        shapeColor: { light: "#ffffff", dark: "#333333" },
        nameColor: { light: "#0D1424", dark: "#dddddd" },
        fontColor: { light: "#0D1424", dark: "#dddddd" },
      },
      options.auraCardDefaults || {},
    );
    // Per-card defaults: matched to the user's working aura.xml sample.
    // The Aura macro RENDERER is permissive (will display users with just
    // {user, info}) but the Aura macro EDITOR strictly validates the
    // per-card shape — it expects every field present, in a specific
    // order. Missing `image` / `backgroundColor` makes the editor refuse
    // to open the macro for editing.
    this.auraPerCardDefaults = Object.assign(
      {
        image: "",
        imageType: "default",  // "default" = use user's profile pic; "link" = use `image` URL
        backgroundColor: "",
      },
      options.auraPerCardDefaults || {},
    );

    // ─────────────────────────────────────────────────────────────────
    //  TARGET APP SELECTION
    // ─────────────────────────────────────────────────────────────────
    // Which Cloud macro do we emit in place of the Linchpin macro?
    //   "aura"        (default) — Aura User Profile (Forge app by Aura Apps).
    //                             Multi-user cards, resolved by accountId.
    //   "userprofile"           — the NATIVE Confluence "User Profile" macro
    //                             (ac:name="profile"). No app/license required.
    //                             ONE user per macro, resolved by accountId.
    //
    // Both consume the SAME resolved Cloud accountIds from the pipeline, so
    // adding this target needs no change to identity resolution — only a
    // different builder at splice time.
    //   "contactperson" — the Forge "Primary Contact Macro" (adf-extension)
    //                      keyed by a Microsoft EntraID object id
    //                      (ms-account-id). ONE person per macro. Rich card
    //                      (position/department/city/phone/Teams).
    this.targetApp = ["userprofile", "contactperson"].includes(options.targetApp)
      ? options.targetApp
      : "aura";

    // Native User Profile macro tunables. Empirically confirmed from a
    // hand-placed sample on the trial site (space TEAM, page 123456792):
    //   <ac:structured-macro ac:name="profile" ac:schema-version="1"
    //        data-layout="default" ac:local-id="<uuid>" ac:macro-id="<64hex>">
    //     <ac:parameter ac:name="user"><ri:user ri:account-id="<id>" /></ac:parameter>
    //   </ac:structured-macro>
    this.profileMacroName = options.profileMacroName || "profile";
    this.profileUserParam = options.profileUserParam || "user";
    this.profileSchemaVersion = options.profileSchemaVersion || 1;
    this.profileDataLayout = options.profileDataLayout || "default";

    // ── Primary Contact Macro (Forge adf-extension) constants ──────────
    // Templated verbatim from the live the trial site macro (page 123456792).
    // The per-macro variables are ms-account-id (the EntraID object id) and
    // local-id (a fresh UUID). Everything else is tenant/app-constant and
    // overridable. The embedded-macro-context is editor metadata Forge
    // re-derives at render (a stale-context sample still rendered), so it is
    // kept as a constant unless overridden.
    this.cpExtensionKey = options.cpExtensionKey ||
      "00000001-0000-4000-8000-000000000001/00000002-0000-4000-8000-000000000002/static/contact-person-macro";
    this.cpExtensionId = options.cpExtensionId ||
      "ari:cloud:ecosystem::extension/00000001-0000-4000-8000-000000000001/00000002-0000-4000-8000-000000000002/static/contact-person-macro";
    this.cpExtensionTitle = options.cpExtensionTitle || "Primary Contact Macro";
    this.cpForgeEnvironment = options.cpForgeEnvironment || "PRODUCTION";
    this.cpCloudId = options.cpCloudId || "00000003-0000-4000-8000-000000000003";
    this.cpWorkspaceAri = options.cpWorkspaceAri ||
      "ari:cloud:confluence:00000003-0000-4000-8000-000000000003:workspace/00000004-0000-4000-8000-000000000004";
    this.cpInserterAccountId = options.cpInserterAccountId || "712020:00000000-0000-0000-0000-000000000000";
    // embedded-macro-context page metadata (re-derived at render; constant OK)
    this.cpEmbeddedContext = Object.assign(
      { contentId: "123456792", contentVersion: 21, spaceKey: "TEAM", spaceId: "155615232" },
      options.cpEmbeddedContext || {},
    );
    // guest-params display config, EXACT order from the live sample, with the
    // ms-account-id slot marked by a placeholder we swap per person.
    this.cpGuestParamsTemplate = options.cpGuestParamsTemplate || (
      '<ac:adf-parameter key="default-config">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="department">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="mail">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="city">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="employee-id">false</ac:adf-parameter>' +
      '<ac:adf-parameter key="ms-teams">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="manager">false</ac:adf-parameter>' +
      '<ac:adf-parameter key="business-phones">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="position">true</ac:adf-parameter>' +
      '<ac:adf-parameter key="ms-account-id">{{MS_ACCOUNT_ID}}</ac:adf-parameter>' +
      '<ac:adf-parameter key="location">false</ac:adf-parameter>'
    );
  }

  // ─────────────────────────────────────────────────────────────────
  //  PARSER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Walk storage XHTML and return every <ac:structured-macro> whose
   * ac:name is in `sourceMacroNames`. Each entry carries the full span
   * needed for a later splice rewrite.
   *
   * @param {string} xml
   * @returns {Array}
   */
  findCandidateMacros(xml) {
    if (!xml || typeof xml !== "string") return [];
    const results = [];

    let i = 0;
    while (i < xml.length) {
      const openIdx = xml.indexOf(STRUCT_OPEN, i);
      const closeIdx = xml.indexOf(STRUCT_CLOSE, i);

      if (openIdx === -1 && closeIdx === -1) break;

      if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        const tagEnd = xml.indexOf(">", openIdx);
        if (tagEnd === -1) break;
        const headerText = xml.slice(openIdx, tagEnd + 1);
        const isSelfClose = xml[tagEnd - 1] === "/";

        const nameMatch = headerText.match(/ac:name\s*=\s*"([^"]+)"/);
        const name = nameMatch ? nameMatch[1] : null;

        if (name && this._sourceNameSet.has(name)) {
          const idMatch = headerText.match(/ac:macro-id\s*=\s*"([^"]+)"/);
          const macroId = idMatch ? idMatch[1] : null;
          const svMatch = headerText.match(/ac:schema-version\s*=\s*"([^"]+)"/);
          const schemaVersion = svMatch ? svMatch[1] : null;

          let spanEnd;
          if (isSelfClose) {
            spanEnd = tagEnd + 1;
          } else {
            spanEnd = this._findMatchingClose(xml, tagEnd + 1);
          }
          if (spanEnd !== -1) {
            const innerStart = tagEnd + 1;
            const innerEnd = isSelfClose ? tagEnd + 1 : spanEnd - STRUCT_CLOSE_LEN;
            const { params, paramSpans } = this._parseTopLevelParams(xml, innerStart, innerEnd);
            results.push({
              name,
              macroId,
              schemaVersion,
              params,
              paramSpans,
              span: [openIdx, spanEnd],
              headerEnd: tagEnd + 1,
              selfClose: isSelfClose,
            });
          }
        }

        i = tagEnd + 1;
      } else {
        i = closeIdx + STRUCT_CLOSE_LEN;
      }
    }

    return results;
  }

  _findMatchingClose(xml, startAfterHeader) {
    let depth = 1;
    let cursor = startAfterHeader;
    while (depth > 0) {
      const nextOpen = xml.indexOf(STRUCT_OPEN, cursor);
      const nextClose = xml.indexOf(STRUCT_CLOSE, cursor);
      if (nextClose === -1) return -1;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const tagEnd = xml.indexOf(">", nextOpen);
        if (tagEnd === -1) return -1;
        const isSelfClose = xml[tagEnd - 1] === "/";
        if (!isSelfClose) depth++;
        cursor = tagEnd + 1;
      } else {
        depth--;
        cursor = nextClose + STRUCT_CLOSE_LEN;
        if (depth === 0) return cursor;
      }
    }
    return -1;
  }

  /**
   * Parse top-level <ac:parameter ac:name="X">value</ac:parameter> blocks
   * within the macro inner range [innerStart, innerEnd). Skips parameters
   * that live inside nested structured-macros (depth-aware walk).
   *
   * @returns {{ params, paramSpans }}
   *   params:     { [paramName]: paramValue }
   *   paramSpans: { [paramName]: [absStart, absEnd] }   — absolute spans in `xml`
   */
  _parseTopLevelParams(xml, innerStart, innerEnd) {
    const params = {};
    const paramSpans = {};
    if (innerEnd <= innerStart) return { params, paramSpans };
    const inner = xml.substring(innerStart, innerEnd);

    const paramRe = /<ac:parameter\b([^>]*?)(?<!\/)>([\s\S]*?)<\/ac:parameter>/g;
    const selfCloseRe = /<ac:parameter\b([^/>]*)\/>/g;
    let depth = 0;
    let pos = 0;

    while (pos < inner.length) {
      const nextOpen = inner.indexOf(STRUCT_OPEN, pos);
      if (depth === 0) {
        const segEnd = nextOpen === -1 ? inner.length : nextOpen;
        const segment = inner.substring(pos, segEnd);
        const segOffset = innerStart + pos;

        paramRe.lastIndex = 0;
        let m;
        while ((m = paramRe.exec(segment)) !== null) {
          const nameMatch = m[1].match(/ac:name\s*=\s*"([^"]+)"/);
          if (!nameMatch) continue;
          const name = nameMatch[1];
          if (name in params) continue;
          params[name] = m[2];
          paramSpans[name] = [segOffset + m.index, segOffset + m.index + m[0].length];
        }

        selfCloseRe.lastIndex = 0;
        while ((m = selfCloseRe.exec(segment)) !== null) {
          const nameMatch = m[1].match(/ac:name\s*=\s*"([^"]+)"/);
          if (!nameMatch) continue;
          const name = nameMatch[1];
          if (name in params) continue;
          params[name] = "";
          paramSpans[name] = [segOffset + m.index, segOffset + m.index + m[0].length];
        }

        if (nextOpen === -1) break;
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
        const nextClose = inner.indexOf(STRUCT_CLOSE, pos);
        if (nextClose === -1) break;
        const inMore = inner.indexOf(STRUCT_OPEN, pos);
        if (inMore !== -1 && inMore < nextClose) {
          const tagEnd = inner.indexOf(">", inMore);
          if (tagEnd === -1) break;
          const isSelfClose = inner[tagEnd - 1] === "/";
          if (!isSelfClose) depth++;
          pos = tagEnd + 1;
        } else {
          depth--;
          pos = nextClose + STRUCT_CLOSE_LEN;
        }
      }
    }
    return { params, paramSpans };
  }

  // ─────────────────────────────────────────────────────────────────
  //  USER TOKEN EXTRACTION
  // ─────────────────────────────────────────────────────────────────

  /**
   * Extract raw user tokens from one Responsibility macro instance.
   *
   * The Linchpin macro's users parameter has been observed (in similar
   * Linchpin macros, and in DC-pattern Atlassian plugins generally) in
   * three shapes — we accept all three:
   *
   *   A. XML user refs inside the param value:
   *      <ac:parameter ac:name="users">
   *        <ri:user ri:account-id="557058:abc-123" />
   *        <ri:user ri:userkey="ff8080812abc" />
   *        <ri:user ri:username="alice" />
   *      </ac:parameter>
   *
   *   B. Comma-separated plain text:
   *      <ac:parameter ac:name="users">alice,bob,carol</ac:parameter>
   *
   *   C. A single bare token:
   *      <ac:parameter ac:name="users">alice</ac:parameter>
   *
   * Returns an array of raw token strings, preserving order, in whatever
   * form they appeared (accountId / userkey / username). Callers feed
   * each through IdentityResolver to resolve to an accountId.
   *
   * @param {object} instance - one entry from findCandidateMacros
   * @returns {string[]}
   */
  extractUserTokens(instance) {
    if (!instance || !instance.params) return [];
    const raw = instance.params[this.sourceUsersParam];
    if (raw == null) return [];
    const val = String(raw).trim();
    if (!val) return [];

    const tokens = [];

    // Shape A: <ri:user .../> tags inside the param value
    const riUserRe = /<ri:user\b([^>]*?)\/>/g;
    let m;
    let foundRiUser = false;
    while ((m = riUserRe.exec(val)) !== null) {
      foundRiUser = true;
      const attrs = m[1];
      const account = attrs.match(/ri:account-id\s*=\s*"([^"]+)"/);
      const userkey = attrs.match(/ri:userkey\s*=\s*"([^"]+)"/);
      const username = attrs.match(/ri:username\s*=\s*"([^"]+)"/);
      if (account) tokens.push(account[1]);
      else if (username) tokens.push(username[1]);
      else if (userkey) tokens.push(userkey[1]);
    }
    if (foundRiUser) return tokens;

    // Shape B/C: plain text, possibly comma-separated
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ─────────────────────────────────────────────────────────────────
  //  REPLACEMENT BUILDER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build one Aura User Profile macro XML for up to `maxUsersPerAura`
   * accountIds. Caller is responsible for chunking.
   *
   * @param {string[]} accountIds
   * @returns {string}
   */
  _buildOneAuraMacro(accountIds) {
    const macroId = this._newMacroId();
    let usersBody;
    if (this.targetUsersUseRiUser) {
      usersBody = accountIds
        .map((id) => `<ri:user ri:account-id="${this._xmlEsc(id)}" />`)
        .join("");
    } else {
      usersBody = this._xmlEsc(accountIds.join(this.targetUserSeparator));
    }
    return (
      `<ac:structured-macro ac:name="${this._xmlEsc(this.targetMacroName)}"` +
      ` ac:schema-version="${this.targetSchemaVersion}"` +
      ` ac:macro-id="${macroId}">` +
      `<ac:parameter ac:name="${this._xmlEsc(this.targetUsersParam)}">${usersBody}</ac:parameter>` +
      `</ac:structured-macro>`
    );
  }

  /**
   * Build the full replacement XHTML for one Responsibility macro.
   *
   * @param {string[]} accountIds
   * @param {object}   [opts]
   * @param {string}   [opts.info]  - Aura per-card `info` label; defaults to
   *                                  this.defaultInfoLabel (only used in rich mode)
   * @returns {string}
   */
  buildAuraReplacement(accountIds, opts) {
    if (!Array.isArray(accountIds) || accountIds.length === 0) return "";
    if (this.auraOutputMode === "rich") {
      return this._buildAuraRichMacro(accountIds, opts || {});
    }
    // Simple mode: chunk at maxUsersPerAura, emit one macro per chunk
    const chunks = [];
    for (let i = 0; i < accountIds.length; i += this.maxUsersPerAura) {
      chunks.push(accountIds.slice(i, i + this.maxUsersPerAura));
    }
    return chunks.map((c) => this._buildOneAuraMacro(c)).join("");
  }

  /**
   * Build ONE Aura User Profile macro in the real Cloud format:
   *
   *   <ac:structured-macro ac:name="aura-user-profile" ac:schema-version="1"
   *                        data-layout="default" ac:local-id="..." ac:macro-id="...">
   *     <ac:parameter ac:name="summary">Info Info Info</ac:parameter>
   *     <ac:parameter ac:name="params">BASE64(URLENCODE(JSON))</ac:parameter>
   *   </ac:structured-macro>
   *
   * The params JSON shape (matching the sample provided by the user):
   *   { "cards": [{ "user": "<accountId>", "info": "<label>", "imageType": "link",
   *                 [...optional image/backgroundColor]}, ...],
   *     "cardSize": "small", "cardStyle": "diagonal", "hover": "none",
   *     "shapeColor": {...}, "nameColor": {...}, "fontColor": {...} }
   *
   * Aura's `cards[]` is unbounded — no need to chunk by maxUsersPerAura
   * in rich mode. (maxUsersPerAura is still respected in simple mode for
   * backward-compat with tests.)
   */
  _buildAuraRichMacro(accountIds, opts) {
    const info = opts.info || this.defaultInfoLabel;
    // Card field order matches the reference Aura sample exactly:
    //   image, imageType, info, user, backgroundColor
    // The editor parses the JSON with strict shape expectations; field
    // order may affect Aura's React state initialization.
    const cards = accountIds.map((accountId) => ({
      image: this.auraPerCardDefaults.image || "",
      imageType: this.auraPerCardDefaults.imageType || "default",
      info,
      user: accountId,
      backgroundColor: this.auraPerCardDefaults.backgroundColor || "",
    }));
    const paramsJson = Object.assign({ cards }, this.auraCardDefaults);
    const paramsString = Buffer.from(encodeURIComponent(JSON.stringify(paramsJson)), "utf8")
      .toString("base64");
    const summary = accountIds.map(() => info).join(" "); // matches sample's "Role Title Role Title"
    const macroId = this._newMacroId();
    const localId = this._newMacroId();
    return (
      `<ac:structured-macro ac:name="${this._xmlEsc(this.targetMacroName)}"` +
      ` ac:schema-version="${this.targetSchemaVersion}"` +
      ` data-layout="default"` +
      ` ac:local-id="${localId}"` +
      ` ac:macro-id="${macroId}">` +
      `<ac:parameter ac:name="summary">${this._xmlEsc(summary)}</ac:parameter>` +
      `<ac:parameter ac:name="params">${paramsString}</ac:parameter>` +
      `</ac:structured-macro>`
    );
  }

  // ─────────────────────────────────────────────────────────────────
  //  NATIVE USER PROFILE ("profile") BUILDER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the full replacement XHTML for one Responsibility macro using the
   * NATIVE Confluence User Profile macro (ac:name="profile").
   *
   * The native macro is strictly SINGLE-user, so N accountIds emit N
   * adjacent `profile` macros (mirrors how Aura simple-mode chunks are
   * concatenated). In practice the Linchpin source resolves to one
   * responsible person per macro, so this is usually a single card.
   *
   * profile_field_identifier (email / confluence.position / cup.field-*) has
   * NO per-field equivalent on the native card — it always renders the
   * standard profile hovercard. The field is therefore dropped (and already
   * reported via lossyParamDrops when it is an element_width-style param).
   *
   * @param {string[]} accountIds
   * @returns {string}
   */
  buildProfileReplacement(accountIds) {
    if (!Array.isArray(accountIds) || accountIds.length === 0) return "";
    return accountIds.map((id) => this._buildOneProfileMacro(id)).join("");
  }

  /**
   * One native User Profile macro for a single accountId.
   * @param {string} accountId
   * @returns {string}
   */
  _buildOneProfileMacro(accountId) {
    const localId = this._newMacroId();      // UUID v4, used by the Cloud editor
    const macroId = this._new64HexId();      // native macros carry a 64-hex id
    return (
      `<ac:structured-macro ac:name="${this._xmlEsc(this.profileMacroName)}"` +
      ` ac:schema-version="${this.profileSchemaVersion}"` +
      ` data-layout="${this._xmlEsc(this.profileDataLayout)}"` +
      ` ac:local-id="${localId}"` +
      ` ac:macro-id="${macroId}">` +
      `<ac:parameter ac:name="${this._xmlEsc(this.profileUserParam)}">` +
      `<ri:user ri:account-id="${this._xmlEsc(accountId)}" />` +
      `</ac:parameter>` +
      `</ac:structured-macro>`
    );
  }

  _new64HexId() {
    // Native Cloud macros use a 64-char hex macro-id (not a UUID).
    return crypto.randomBytes(32).toString("hex");
  }

  // ─────────────────────────────────────────────────────────────────
  //  CONTACT PERSON MACRO (Forge adf-extension) BUILDER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the full replacement XHTML for one Responsibility macro using the
   * Forge "Primary Contact Macro" (adf-extension), keyed by EntraID object id.
   *
   * The macro is SINGLE-person, so N object ids emit N adjacent adf-extension
   * cards (mirrors the native-profile target). Each renders a rich card
   * (position / department / city / mail / phone / Teams) resolved from
   * EntraID by the app at render time.
   *
   * @param {string[]} msAccountIds  EntraID object ids (ms-account-id values)
   * @returns {string}
   */
  buildContactPersonReplacement(msAccountIds) {
    if (!Array.isArray(msAccountIds) || msAccountIds.length === 0) return "";
    return msAccountIds.map((id) => this._buildOneContactPersonMacro(id)).join("");
  }

  /**
   * One Primary Contact adf-extension for a single EntraID object id.
   * Emits the main <ac:adf-node> plus its identical <ac:adf-fallback> copy,
   * both sharing one fresh local-id.
   * @param {string} msAccountId  EntraID object id
   * @returns {string}
   */
  _buildOneContactPersonMacro(msAccountId) {
    const localId = this._newMacroId();
    const ec = this.cpEmbeddedContext;
    const guestParams = this.cpGuestParamsTemplate.replace(
      "{{MS_ACCOUNT_ID}}",
      this._xmlEsc(msAccountId),
    );
    const node =
      `<ac:adf-node type="extension">` +
        `<ac:adf-attribute key="extension-key">${this._xmlEsc(this.cpExtensionKey)}</ac:adf-attribute>` +
        `<ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>` +
        `<ac:adf-attribute key="parameters">` +
          `<ac:adf-parameter key="local-id">${localId}</ac:adf-parameter>` +
          `<ac:adf-parameter key="extension-id">${this._xmlEsc(this.cpExtensionId)}</ac:adf-parameter>` +
          `<ac:adf-parameter key="extension-title">${this._xmlEsc(this.cpExtensionTitle)}</ac:adf-parameter>` +
          `<ac:adf-parameter key="layout">extension</ac:adf-parameter>` +
          `<ac:adf-parameter key="forge-environment">${this._xmlEsc(this.cpForgeEnvironment)}</ac:adf-parameter>` +
          `<ac:adf-parameter key="embedded-macro-context">` +
            `<ac:adf-parameter key="extension-data">` +
              `<ac:adf-parameter key="type">macro</ac:adf-parameter>` +
              `<ac:adf-parameter key="content">` +
                `<ac:adf-parameter key="id">${this._xmlEsc(ec.contentId)}</ac:adf-parameter>` +
                `<ac:adf-parameter key="type">page</ac:adf-parameter>` +
                `<ac:adf-parameter key="version" type="integer">${this._xmlEsc(ec.contentVersion)}</ac:adf-parameter>` +
              `</ac:adf-parameter>` +
              `<ac:adf-parameter key="space">` +
                `<ac:adf-parameter key="key">${this._xmlEsc(ec.spaceKey)}</ac:adf-parameter>` +
                `<ac:adf-parameter key="id">${this._xmlEsc(ec.spaceId)}</ac:adf-parameter>` +
              `</ac:adf-parameter>` +
            `</ac:adf-parameter>` +
            `<ac:adf-parameter key="context-ids"><ac:adf-parameter-value>${this._xmlEsc(this.cpWorkspaceAri)}</ac:adf-parameter-value></ac:adf-parameter>` +
            `<ac:adf-parameter key="account-id">${this._xmlEsc(this.cpInserterAccountId)}</ac:adf-parameter>` +
            `<ac:adf-parameter key="cloud-id">${this._xmlEsc(this.cpCloudId)}</ac:adf-parameter>` +
          `</ac:adf-parameter>` +
          `<ac:adf-parameter key="guest-params">${guestParams}</ac:adf-parameter>` +
        `</ac:adf-attribute>` +
        `<ac:adf-attribute key="text">${this._xmlEsc(this.cpExtensionTitle)}</ac:adf-attribute>` +
        `<ac:adf-attribute key="layout">default</ac:adf-attribute>` +
        `<ac:adf-attribute key="local-id">${localId}</ac:adf-attribute>` +
      `</ac:adf-node>`;
    return `<ac:adf-extension>${node}<ac:adf-fallback>${node}</ac:adf-fallback></ac:adf-extension>`;
  }

  _newMacroId() {
    // Confluence macro IDs are UUID v4 strings.
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString("hex");
    return (
      hex.substring(0, 8) +
      "-" +
      hex.substring(8, 12) +
      "-" +
      hex.substring(12, 16) +
      "-" +
      hex.substring(16, 20) +
      "-" +
      hex.substring(20, 32)
    );
  }

  _xmlEsc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─────────────────────────────────────────────────────────────────
  //  REWRITE
  // ─────────────────────────────────────────────────────────────────

  /**
   * Splice-rewrite one page's storage XHTML.
   *
   * For each instance in `instances`:
   *   - Look up its resolved accountIds in `accountIdsByMacroKey` (key:
   *     macroId if present, else span start as a fallback)
   *   - If no resolved accountIds (unresolved or empty): skip
   *   - Otherwise: replace the whole `<ac:structured-macro …>…</ac:structured-macro>`
   *     span with `buildAuraReplacement(accountIds)`
   *
   * Edits are applied back-to-front to keep spans stable.
   *
   * Lossy parameters (additionalInformation / width) are detected and
   * reported in `lossyParamDrops` but always dropped.
   *
   * @param {string} xml
   * @param {Array}  instances - from findCandidateMacros
   * @param {Object<string, string[]>} accountIdsByMacroKey
   * @returns {{ newXml, changes, skipped, lossyParamDrops }}
   */
  rewriteStorage(xml, instances, accountIdsByMacroKey) {
    const changes = [];
    const skipped = [];
    const lossyParamDrops = [];

    const accepted = [];
    for (const inst of instances) {
      const key = this._instanceKey(inst);
      const accountIds = (accountIdsByMacroKey && accountIdsByMacroKey[key]) || null;
      if (!Array.isArray(accountIds) || accountIds.length === 0) {
        skipped.push({
          macroId: inst.macroId,
          name: inst.name,
          span: inst.span,
          reason: "no-resolved-accountids",
        });
        continue;
      }
      // Detect lossy params
      for (const lp of this.lossyParams) {
        if (lp in (inst.params || {}) && inst.params[lp] !== "") {
          lossyParamDrops.push({
            macroId: inst.macroId,
            paramName: lp,
            droppedValue: inst.params[lp],
          });
        }
      }
      accepted.push({ inst, accountIds });
    }

    // Sort descending by start position so earlier spans don't shift.
    accepted.sort((a, b) => b.inst.span[0] - a.inst.span[0]);

    let cur = xml;
    for (const { inst, accountIds } of accepted) {
      let [start, end] = inst.span;
      // Map the source macro's profile_field_identifier to Aura's per-card info label.
      const sourceField = (inst.params || {})[this.sourceProfileFieldParam] || null;
      const info = (sourceField && this.profileFieldToInfoMap[sourceField]) || this.defaultInfoLabel;
      const replacement = this.targetApp === "userprofile"
        ? this.buildProfileReplacement(accountIds)
        : this.targetApp === "contactperson"
        ? this.buildContactPersonReplacement(accountIds)
        : this.buildAuraReplacement(accountIds, { info });

      // EDITOR-COMPAT FIX: Aura is a block-level macro; Confluence's
      // editor refuses to open a page whose ADF has a block extension
      // inside an inline paragraph node. The renderer is permissive
      // (which is why this only manifests in editor mode).
      //
      // Two paragraph-wrap shapes need handling:
      //   solo:  <p>[ws]MACRO[ws]</p>
      //          → replace whole <p>...</p> with `<p />` + MACRO
      //
      //   mixed: <p>BEFORE_CONTENT MACRO AFTER_CONTENT</p>
      //          → split: `<p>BEFORE_CONTENT</p>` + MACRO + `<p>AFTER_CONTENT</p>`
      //          (drop empty halves; if both empty falls through to solo)
      let prefix = "";
      let suffix = "";
      let paragraphSwallowed = false;
      let paragraphSplit = false;
      const wrap = this._detectParagraphWrapper(cur, start, end);
      if (wrap) {
        start = wrap.pStart;
        end = wrap.pEnd;
        if (wrap.kind === "solo") {
          prefix = "<p />";
          paragraphSwallowed = true;
        } else {
          // mixed
          const beforeTrim = wrap.before.trim();
          const afterTrim = wrap.after.trim();
          if (beforeTrim) prefix = `<p>${wrap.before}</p>`;
          if (afterTrim) suffix = `<p>${wrap.after}</p>`;
          if (!prefix) prefix = "<p />";  // anchor placeholder for editor
          paragraphSplit = true;
        }
      }

      cur = cur.slice(0, start) + prefix + replacement + suffix + cur.slice(end);
      changes.push({
        macroId: inst.macroId,
        oldName: inst.name,
        newName: this.targetApp === "userprofile" ? this.profileMacroName
          : this.targetApp === "contactperson" ? "contact-person-macro"
          : this.targetMacroName,
        accountIds,
        info,
        sourceField,
        chunks: (this.targetApp === "userprofile" || this.targetApp === "contactperson")
          ? accountIds.length  // single-person macros: one per user
          : (this.auraOutputMode === "rich" ? 1 : Math.ceil(accountIds.length / this.maxUsersPerAura)),
        paragraphSwallowed,
        paragraphSplit,
        span: inst.span,
      });
    }

    return { newXml: cur, changes, skipped, lossyParamDrops };
  }

  /**
   * Detect whether the source macro at [macroStart, macroEnd] is inside
   * a surrounding <p>...</p> paragraph. Returns one of:
   *   null                            — macro is NOT in a <p>
   *   { kind: "solo", pStart, pEnd }  — macro is the only content of
   *                                     the <p> (whitespace allowed)
   *   { kind: "mixed", pStart, pEnd,
   *     before, after }               — paragraph contains other
   *                                     content alongside the macro;
   *                                     `before`/`after` are the
   *                                     pre/post inner-content strings
   *
   * Strategy: scan backward from the macro to find the nearest open
   * <p>, then scan forward to find the next </p>. Walk the inner-
   * paragraph content excluding nested structured-macros to detect
   * "solo" (only whitespace + this one macro).
   */
  _detectParagraphWrapper(xml, macroStart, macroEnd) {
    // Find the nearest open <p> tag whose matching </p> is AFTER the
    // macro. Naive scan: walk backward looking for "<p" or "<p ".
    let pOpenIdx = -1;
    let pOpenEnd = -1;
    let cursor = macroStart;
    while (cursor > 0) {
      const i = xml.lastIndexOf("<p", cursor);
      if (i === -1) break;
      const next = xml[i + 2];
      // Must be <p> or <p with whitespace (not <pre>, <param>, <picture>)
      if (next === ">" || next === " " || next === "\t" || next === "\n" || next === "/") {
        // Find tag end
        const tagEnd = xml.indexOf(">", i);
        if (tagEnd === -1) { cursor = i - 1; continue; }
        const openTag = xml.substring(i, tagEnd + 1);
        // Skip self-closing <p />
        if (openTag.endsWith("/>")) { cursor = i - 1; continue; }
        // Find matching </p> from here
        // Use a depth scan since paragraphs don't nest in practice, but be defensive
        const close = xml.indexOf("</p>", tagEnd + 1);
        if (close === -1 || close < macroEnd) { cursor = i - 1; continue; }
        // Confirm no intervening </p> before the macro
        const interveningClose = xml.indexOf("</p>", tagEnd + 1);
        if (interveningClose !== -1 && interveningClose < macroStart) {
          cursor = i - 1; continue;
        }
        pOpenIdx = i;
        pOpenEnd = tagEnd + 1;
        break;
      }
      cursor = i - 1;
    }
    if (pOpenIdx === -1) return null;
    const pCloseIdx = xml.indexOf("</p>", macroEnd);
    if (pCloseIdx === -1) return null;
    const pEnd = pCloseIdx + 4;

    const before = xml.substring(pOpenEnd, macroStart);
    const after = xml.substring(macroEnd, pCloseIdx);

    // Solo: before/after are only whitespace
    if (before.trim() === "" && after.trim() === "") {
      return { kind: "solo", pStart: pOpenIdx, pEnd };
    }
    return { kind: "mixed", pStart: pOpenIdx, pEnd, before, after };
  }

  /**
   * Stable key for an instance — used to align resolved accountIds
   * back to the right macro on rewrite. Prefers macroId (always
   * present on Cloud-migrated macros); falls back to span start.
   */
  _instanceKey(inst) {
    if (inst && inst.macroId) return `mid:${inst.macroId}`;
    if (inst && inst.span) return `span:${inst.span[0]}`;
    return `unknown:${Math.random()}`;
  }

  // ─────────────────────────────────────────────────────────────────
  //  DIFF HELPER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Tiny line-based unified diff. Same as composition-tabs — informational
   * only, used to write a human-readable .diff.patch alongside each
   * backup. Never parsed by the restore script.
   */
  unifiedDiff(oldXml, newXml, contextLines = 3) {
    const a = String(oldXml || "").split(/\r?\n/);
    const b = String(newXml || "").split(/\r?\n/);
    if (oldXml === newXml) return "";

    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const script = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { script.push({ op: "=", line: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { script.push({ op: "-", line: a[i] }); i++; }
      else { script.push({ op: "+", line: b[j] }); j++; }
    }
    while (i < n) { script.push({ op: "-", line: a[i++] }); }
    while (j < m) { script.push({ op: "+", line: b[j++] }); }

    const hunks = [];
    let k = 0;
    while (k < script.length) {
      if (script[k].op === "=") {
        let nextChange = k;
        while (nextChange < script.length && script[nextChange].op === "=") nextChange++;
        if (nextChange === script.length) break;
        k = Math.max(k, nextChange - contextLines);
      }
      const hunkStart = k;
      let p = k;
      while (p < script.length) {
        if (script[p].op !== "=") { p++; continue; }
        let look = p;
        let foundChange = false;
        const limit = Math.min(script.length, p + 2 * contextLines);
        while (look < limit) { if (script[look].op !== "=") { foundChange = true; break; } look++; }
        if (foundChange) { p++; continue; }
        const hunkEnd = Math.min(script.length, p + contextLines);
        hunks.push(script.slice(hunkStart, hunkEnd));
        k = hunkEnd;
        break;
      }
      if (p >= script.length) {
        hunks.push(script.slice(hunkStart));
        break;
      }
    }

    if (hunks.length === 0) return "";

    let out = "";
    for (const hunk of hunks) {
      out += `@@ -? +? @@\n`;
      for (const s of hunk) {
        const prefix = s.op === "=" ? " " : s.op;
        out += `${prefix}${s.line}\n`;
      }
    }
    return out;
  }
}

ResponsibilityMacroProcessor.DEFAULT_SOURCE_NAMES = Object.freeze([
  "responsibility",
  "content-responsibility",
  "contentresponsibility",
  "page-responsibility",
  "content-responsibility-macro",
]);

ResponsibilityMacroProcessor.DEFAULT_LOSSY_PARAMS = Object.freeze([
  "additionalInformation",
  "additional-information",
  "width",
  "macroWidth",
  "macro-width",
]);

module.exports = ResponsibilityMacroProcessor;
