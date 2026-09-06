/**
 * compositionMacroProcessor.js
 *
 * Splice-rewrite engine for fixing mis-migrated Appfire Composition Tabs
 * macros in Confluence Cloud storage XHTML.
 *
 * After Atlassian DC -> Cloud migration, Composition's Deck/Card macros
 * sometimes land in Cloud as <ac:structured-macro ac:name="deck"> /
 * ac:name="card">. Those names collide with Confluence Cloud native
 * macros and break rendering. Appfire's Cloud-compatible legacy
 * equivalents are tab-group / tab.
 *
 * This module is pure XHTML string manipulation. No network. The entry
 * script is responsible for fetching pages, deciding what to write back,
 * saving backups, and PUTting via CloudConfluenceClient.
 *
 * Public surface:
 *   processor.findCandidateMacros(storageXml)
 *     -> [{ name, macroId, params, parent_name, ancestors, span, headerEnd, selfClose }]
 *   processor.shouldRewrite(instance)
 *     -> { rewrite: boolean, reason: string }
 *   processor.rewriteStorage(storageXml, instances, mappingRules?)
 *     -> { newXml, changes: [{macroId, oldName, newName, paramRenames, paramDeletes, reason}] }
 *   processor.unifiedDiff(oldXml, newXml, contextLines?)
 *     -> string
 *   CompositionMacroProcessor.MAPPING_RULES_DEFAULT
 *
 * The parser walker re-uses the depth-tracking pattern from
 * confluence/visibility-macro/src/visibilityMacroProcessor.js
 * (extractDcParamsFromStorage / _parseTopLevelParams). It additionally
 * tracks an ancestorStack of currently-open structured-macros so card
 * instances know their parent context.
 *
 * Why splice and not parse-and-serialize:
 *   Confluence storage XHTML carries xmlns:ac/xmlns:ri only in some
 *   contexts; xmldom round-trips reorder attributes, normalize whitespace
 *   inside <ac:rich-text-body>, and produce technically-equivalent but
 *   byte-different output that bloats version diffs and risks tripping
 *   on edge XML cases. Splice rewrites guarantee the only deltas are
 *   the substrings we explicitly chose to change.
 */

"use strict";

const STRUCT_OPEN = "<ac:structured-macro";
const STRUCT_CLOSE = "</ac:structured-macro>";
const STRUCT_CLOSE_LEN = STRUCT_CLOSE.length;

class CompositionMacroProcessor {
  /**
   * @param {object} options
   * @param {string[]} [options.oldDeckKeys=["deck"]]   - DC macro keys to map to tab-group
   * @param {string[]} [options.oldCardKeys=["card"]]   - DC macro keys to map to tab
   * @param {object}   [options.mappingRules]          - per-old-name { newName, paramRenames }
   * @param {Function} [options.log=console.log]
   * @param {boolean}  [options.renameDeckId=true]      - also rename deck `id` -> `deckId`
   * @param {string}   [options.cardLabelParam="label"] - source param name to rename to title
   * @param {string}   [options.cardTitleParam="title"] - target param name on tab
   */
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.oldDeckKeys = (options.oldDeckKeys && options.oldDeckKeys.length)
      ? options.oldDeckKeys.map((s) => String(s)) : ["deck"];
    this.oldCardKeys = (options.oldCardKeys && options.oldCardKeys.length)
      ? options.oldCardKeys.map((s) => String(s)) : ["card"];

    const renameDeckId = options.renameDeckId !== false;
    const cardLabelParam = options.cardLabelParam || "label";
    const cardTitleParam = options.cardTitleParam || "title";

    if (options.mappingRules) {
      this.mappingRules = options.mappingRules;
    } else {
      this.mappingRules = {};
      for (const k of this.oldDeckKeys) {
        this.mappingRules[k] = {
          newName: "tab-group",
          paramRenames: renameDeckId ? { id: "deckId" } : {},
        };
      }
      for (const k of this.oldCardKeys) {
        this.mappingRules[k] = {
          newName: "tab",
          paramRenames: { [cardLabelParam]: cardTitleParam },
        };
      }
    }

    // Sets used for ancestor classification.
    this._oldDeckSet = new Set(this.oldDeckKeys);
    this._oldCardSet = new Set(this.oldCardKeys);
    // Composition-ancestor names are the old keys plus their conversion targets.
    // A leftover card under a tab-group from a partial prior conversion still
    // counts as Composition.
    this._compositionAncestors = new Set([
      ...this.oldDeckKeys,
      ...this.oldCardKeys,
      "tab-group",
      "tab",
    ]);
  }

  // ─────────────────────────────────────────────────────────────────
  //  PARSER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Walk storage XHTML and return every structured-macro whose name is in
   * oldDeckKeys ∪ oldCardKeys. Each entry has full span info needed to
   * splice-rewrite later.
   *
   * @param {string} xml
   * @returns {Array<{
   *   name: string,
   *   macroId: string|null,
   *   params: Object,
   *   parent_name: string|null,
   *   ancestors: string[],
   *   span: [number, number],
   *   headerEnd: number,
   *   selfClose: boolean,
   * }>}
   */
  findCandidateMacros(xml) {
    if (!xml || typeof xml !== "string") return [];
    const allowed = new Set([...this.oldDeckKeys, ...this.oldCardKeys]);
    const results = [];
    const ancestorStack = []; // names of currently-open structured-macros

    let i = 0;
    while (i < xml.length) {
      const openIdx = xml.indexOf(STRUCT_OPEN, i);
      const closeIdx = xml.indexOf(STRUCT_CLOSE, i);

      if (openIdx === -1 && closeIdx === -1) break;

      // Whichever comes first wins.
      if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        const tagEnd = xml.indexOf(">", openIdx);
        if (tagEnd === -1) break;
        const headerText = xml.slice(openIdx, tagEnd + 1);
        const isSelfClose = xml[tagEnd - 1] === "/";
        const nameMatch = headerText.match(/ac:name\s*=\s*"([^"]+)"/);
        const name = nameMatch ? nameMatch[1] : null;
        const idMatch = headerText.match(/ac:macro-id\s*=\s*"([^"]+)"/);
        const macroId = idMatch ? idMatch[1] : null;

        if (name && allowed.has(name)) {
          // Find this macro's full span (for splice rewrites).
          let spanEnd;
          if (isSelfClose) {
            spanEnd = tagEnd + 1;
          } else {
            spanEnd = this._findMatchingClose(xml, tagEnd + 1);
          }
          if (spanEnd !== -1) {
            const innerStart = tagEnd + 1;
            const innerEnd = isSelfClose ? tagEnd + 1 : spanEnd - STRUCT_CLOSE_LEN;
            const params = this._parseTopLevelParams(xml, innerStart, innerEnd);
            results.push({
              name,
              macroId,
              params,
              parent_name: ancestorStack.length ? ancestorStack[ancestorStack.length - 1] : null,
              ancestors: [...ancestorStack],
              span: [openIdx, spanEnd],
              headerEnd: tagEnd + 1,
              selfClose: isSelfClose,
            });
          }
        }

        // Advance past the opening tag. We ALWAYS push something onto the
        // ancestor stack for non-self-closing opens so the matching close
        // tag's pop() stays balanced — even if the open tag is malformed
        // and has no `ac:name` attribute. Without this guard, an unnamed
        // open tag would skip the push but the corresponding close would
        // still pop, corrupting parent_name for every subsequent macro.
        // For unnamed macros we push the sentinel "<unnamed>" so the
        // ancestor name is non-null but won't accidentally match a
        // legitimate Composition ancestor name.
        if (isSelfClose) {
          // self-closing: no descent, no push
          i = tagEnd + 1;
        } else {
          ancestorStack.push(name || "<unnamed>");
          i = tagEnd + 1;
        }
      } else {
        // Close tag wins. Guard against underflow (extra close without a
        // prior open — possible only with malformed input).
        if (ancestorStack.length > 0) ancestorStack.pop();
        i = closeIdx + STRUCT_CLOSE_LEN;
      }
    }

    return results;
  }

  /**
   * Given an absolute index pointing AFTER an opening structured-macro
   * tag, return the absolute end index just past its matching
   * </ac:structured-macro>. Self-closing children don't bump depth.
   * Returns -1 if no balanced close is found.
   */
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
   * that are inside nested structured-macros.
   *
   * Returns { paramName: paramValue, ... } as plain strings (no XML decode).
   *
   * Self-closing parameters (`<ac:parameter ac:name="X" />`) are recorded
   * with empty-string value.
   */
  _parseTopLevelParams(xml, innerStart, innerEnd) {
    const params = {};
    if (innerEnd <= innerStart) return params;
    const inner = xml.substring(innerStart, innerEnd);

    // Reuse the depth-aware walker pattern from visibility-macro.
    // [^>]*?(?<!\/) rejects self-closing parameters from the regex's match,
    // because their `/` precedes the `>` and the negative lookbehind fires.
    const paramRe = /<ac:parameter\b([^>]*?)(?<!\/)>([\s\S]*?)<\/ac:parameter>/g;
    const selfCloseRe = /<ac:parameter\b([^/>]*)\/>/g;
    let depth = 0;
    let pos = 0;
    while (pos < inner.length) {
      const nextOpen = inner.indexOf(STRUCT_OPEN, pos);
      if (depth === 0) {
        const segEnd = nextOpen === -1 ? inner.length : nextOpen;
        const segment = inner.substring(pos, segEnd);

        // Open-close param blocks
        paramRe.lastIndex = 0;
        let m;
        while ((m = paramRe.exec(segment)) !== null) {
          const nameMatch = m[1].match(/ac:name\s*=\s*"([^"]+)"/);
          if (!nameMatch) continue;
          if (!(nameMatch[1] in params)) {
            params[nameMatch[1]] = m[2];
          }
        }

        // Self-closing param tags
        selfCloseRe.lastIndex = 0;
        while ((m = selfCloseRe.exec(segment)) !== null) {
          const nameMatch = m[1].match(/ac:name\s*=\s*"([^"]+)"/);
          if (!nameMatch) continue;
          if (!(nameMatch[1] in params)) {
            params[nameMatch[1]] = "";
          }
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
    return params;
  }

  // ─────────────────────────────────────────────────────────────────
  //  SHOULD-REWRITE DECISION
  // ─────────────────────────────────────────────────────────────────

  /**
   * Default-deny verification: rewrite a deck instance always; rewrite a
   * card only if it has a Composition ancestor (deck/tab-group/tab) or a
   * Composition-style `label` parameter.
   *
   * @param {object} instance - one entry from findCandidateMacros
   * @returns {{ rewrite: boolean, reason: string }}
   */
  shouldRewrite(instance) {
    if (!instance || !instance.name) return { rewrite: false, reason: "no-name" };
    if (this._oldDeckSet.has(instance.name)) {
      return { rewrite: true, reason: "deck-always" };
    }
    if (this._oldCardSet.has(instance.name)) {
      const hasCompositionAncestor = (instance.ancestors || []).some(
        (a) => this._compositionAncestors.has(a),
      );
      if (hasCompositionAncestor) {
        return { rewrite: true, reason: "card-composition-ancestor" };
      }
      // Heuristic: if the card carries a Composition-shaped param name
      // (defaults to "label"), we trust it's the Appfire macro.
      const labelKey = Object.keys(this.mappingRules[instance.name]?.paramRenames || {})[0];
      if (labelKey && labelKey in (instance.params || {})) {
        return { rewrite: true, reason: `card-has-${labelKey}-param` };
      }
      return { rewrite: false, reason: "ambiguous-card-no-deck-ancestor-no-label" };
    }
    return { rewrite: false, reason: "name-not-in-old-keys" };
  }

  // ─────────────────────────────────────────────────────────────────
  //  REWRITER
  // ─────────────────────────────────────────────────────────────────

  /**
   * Apply splice rewrites to storage XHTML for every instance flagged by
   * shouldRewrite(). Operates back-to-front so earlier rewrites don't
   * shift later spans.
   *
   * @param {string} xml
   * @param {Array}  instances - from findCandidateMacros
   * @param {Object} [rulesOverride] - per-old-name { newName, paramRenames }
   * @returns {{ newXml: string, changes: Array, skipped: Array }}
   */
  rewriteStorage(xml, instances, rulesOverride) {
    const rules = rulesOverride || this.mappingRules;
    const changes = [];
    const skipped = [];

    const accepted = [];
    for (const inst of instances) {
      const decision = this.shouldRewrite(inst);
      if (decision.rewrite) {
        accepted.push({ inst, decision });
      } else {
        skipped.push({
          macroId: inst.macroId,
          name: inst.name,
          span: inst.span,
          reason: decision.reason,
        });
      }
    }

    // Sort descending by start position so earlier spans don't shift.
    accepted.sort((a, b) => b.inst.span[0] - a.inst.span[0]);

    let cur = xml;
    for (const { inst, decision } of accepted) {
      const rule = rules[inst.name];
      if (!rule || !rule.newName) {
        skipped.push({
          macroId: inst.macroId,
          name: inst.name,
          span: inst.span,
          reason: "no-rule-for-name",
        });
        continue;
      }
      const [start, end] = inst.span;
      const macroXml = cur.slice(start, end);
      const headerLen = inst.headerEnd - start;
      const header = macroXml.slice(0, headerLen);
      const rest = macroXml.slice(headerLen);

      // 1. Rewrite ac:name on the OPENING tag only.
      const newHeader = header.replace(
        /(\bac:name\s*=\s*")([^"]+)(")/,
        (_full, p1, _name, p3) => `${p1}${rule.newName}${p3}`,
      );

      // 2. Rewrite (or delete) top-level ac:parameter ac:name="X" -> "Y"
      // within `rest`. `rest` is everything after the macro's opening
      // tag; the macro inner body is rest minus the trailing
      // </ac:structured-macro> for non-self-close macros (or empty for
      // self-close macros).
      let newRest = rest;
      if (!inst.selfClose) {
        const innerLen = rest.length - STRUCT_CLOSE_LEN;
        if (innerLen > 0) {
          const innerOriginal = rest.slice(0, innerLen);
          const closer = rest.slice(innerLen);
          const { newInner, paramRenames, paramDeletes } = this._rewriteParams(
            innerOriginal,
            inst.params,
            rule.paramRenames || {},
          );
          newRest = newInner + closer;
          changes.push({
            macroId: inst.macroId,
            oldName: inst.name,
            newName: rule.newName,
            paramRenames,
            paramDeletes,
            ancestor: inst.parent_name,
            reason: decision.reason,
            span: inst.span,
          });
        } else {
          changes.push({
            macroId: inst.macroId,
            oldName: inst.name,
            newName: rule.newName,
            paramRenames: [],
            paramDeletes: [],
            ancestor: inst.parent_name,
            reason: decision.reason,
            span: inst.span,
          });
        }
      } else {
        changes.push({
          macroId: inst.macroId,
          oldName: inst.name,
          newName: rule.newName,
          paramRenames: [],
          paramDeletes: [],
          ancestor: inst.parent_name,
          reason: decision.reason,
          span: inst.span,
        });
      }

      const newMacro = newHeader + newRest;
      cur = cur.slice(0, start) + newMacro + cur.slice(end);
    }

    return { newXml: cur, changes, skipped };
  }

  /**
   * Walk the inner body of one macro at depth 0, find every top-level
   * <ac:parameter ac:name="X">..</ac:parameter> block (and self-closing
   * variant), and either rename or delete each one according to renames.
   *
   * Conflict resolution: if `X -> Y` is requested and Y already exists
   * in the macro's top-level params, delete the X block instead of
   * renaming (Y wins as the canonical form, X was probably a leftover).
   *
   * Edits are applied back-to-front to keep offsets stable.
   *
   * @returns {{ newInner, paramRenames: Array, paramDeletes: Array }}
   */
  _rewriteParams(inner, existingParams, renameMap) {
    const renameKeys = Object.keys(renameMap);
    if (renameKeys.length === 0) {
      return { newInner: inner, paramRenames: [], paramDeletes: [] };
    }

    // Collect edit ops: each is either { type: "rename", from, to, nameValueSpan }
    // or { type: "delete", paramSpan }.
    const ops = [];

    const paramRenames = [];
    const paramDeletes = [];

    const handleParamHit = (absStart, absEnd, headerText) => {
      const nameMatch = headerText.match(/ac:name\s*=\s*"([^"]+)"/);
      if (!nameMatch) return;
      const oldParamName = nameMatch[1];
      if (!(oldParamName in renameMap)) return;
      const newParamName = renameMap[oldParamName];
      // Conflict: target name already present at top level → delete the old.
      if (newParamName in existingParams && newParamName !== oldParamName) {
        ops.push({ type: "delete", paramSpan: [absStart, absEnd] });
        paramDeletes.push({ name: oldParamName, reason: `conflict-${newParamName}-already-present` });
        return;
      }
      // Otherwise: rename. Find absolute position of the value substring of ac:name="...".
      const attrRe = /ac:name\s*=\s*"([^"]+)"/;
      const headerOnly = headerText;
      const attrMatch = headerOnly.match(attrRe);
      if (!attrMatch) return;
      const attrIdxInHeader = attrMatch.index;
      // The literal value starts after `ac:name="` (length 9) within the attr region.
      const fullAttrText = attrMatch[0];
      const valueStartInAttr = fullAttrText.indexOf('"') + 1;
      const valueAbsStart = absStart + attrIdxInHeader + valueStartInAttr;
      const valueAbsEnd = valueAbsStart + oldParamName.length;
      ops.push({ type: "rename", from: oldParamName, to: newParamName, valueSpan: [valueAbsStart, valueAbsEnd] });
      paramRenames.push({ from: oldParamName, to: newParamName });
    };

    // Walk inner depth-aware to find top-level param tags.
    const paramRe = /<ac:parameter\b([^>]*?)(?<!\/)>([\s\S]*?)<\/ac:parameter>/g;
    const selfCloseRe = /<ac:parameter\b([^/>]*)\/>/g;
    let depth = 0;
    let pos = 0;
    while (pos < inner.length) {
      const nextOpen = inner.indexOf(STRUCT_OPEN, pos);
      if (depth === 0) {
        const segEnd = nextOpen === -1 ? inner.length : nextOpen;
        const segment = inner.substring(pos, segEnd);

        // Open-close
        paramRe.lastIndex = 0;
        let m;
        while ((m = paramRe.exec(segment)) !== null) {
          const segOffset = pos;
          const absStart = segOffset + m.index;
          const absEnd = absStart + m[0].length;
          // header is up to and including the first ">"
          const headerEndRel = m[0].indexOf(">") + 1;
          const headerText = m[0].substring(0, headerEndRel);
          handleParamHit(absStart, absEnd, headerText);
        }

        // Self-closing
        selfCloseRe.lastIndex = 0;
        while ((m = selfCloseRe.exec(segment)) !== null) {
          const segOffset = pos;
          const absStart = segOffset + m.index;
          const absEnd = absStart + m[0].length;
          const headerText = m[0];
          handleParamHit(absStart, absEnd, headerText);
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

    if (ops.length === 0) {
      return { newInner: inner, paramRenames: [], paramDeletes: [] };
    }

    // Apply ops back-to-front.
    ops.sort((a, b) => {
      const aStart = a.type === "rename" ? a.valueSpan[0] : a.paramSpan[0];
      const bStart = b.type === "rename" ? b.valueSpan[0] : b.paramSpan[0];
      return bStart - aStart;
    });

    let out = inner;
    for (const op of ops) {
      if (op.type === "rename") {
        const [s, e] = op.valueSpan;
        out = out.slice(0, s) + op.to + out.slice(e);
      } else if (op.type === "delete") {
        const [s, e] = op.paramSpan;
        out = out.slice(0, s) + out.slice(e);
      }
    }

    return { newInner: out, paramRenames, paramDeletes };
  }

  // ─────────────────────────────────────────────────────────────────
  //  DIFF HELPER (informational; backups only)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Tiny line-based unified diff. NOT a full diff implementation — this
   * groups runs of equal/different lines via a simple longest-common-prefix
   * walk per chunk. Good enough for human-readable backup .diff.patch
   * files; never parsed by the restore script.
   */
  unifiedDiff(oldXml, newXml, contextLines = 3) {
    const a = String(oldXml || "").split(/\r?\n/);
    const b = String(newXml || "").split(/\r?\n/);
    if (oldXml === newXml) return "";

    // Build a simple LCS-ish line diff using the classic dynamic-prog
    // approach. For very large pages this is O(n*m) memory — acceptable
    // since storage XHTML is rarely > a few thousand lines.
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    // Walk to produce edit script
    const script = []; // {op: '=' | '-' | '+', line}
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { script.push({ op: "=", line: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { script.push({ op: "-", line: a[i] }); i++; }
      else { script.push({ op: "+", line: b[j] }); j++; }
    }
    while (i < n) { script.push({ op: "-", line: a[i++] }); }
    while (j < m) { script.push({ op: "+", line: b[j++] }); }

    // Group into hunks with context.
    const hunks = [];
    let k = 0;
    while (k < script.length) {
      // Skip leading equal runs unless near a change
      if (script[k].op === "=") {
        // find next change
        let nextChange = k;
        while (nextChange < script.length && script[nextChange].op === "=") nextChange++;
        if (nextChange === script.length) break;
        k = Math.max(k, nextChange - contextLines);
      }
      // Build hunk starting at k, with `contextLines` of trailing context
      const hunkStart = k;
      let p = k;
      while (p < script.length) {
        if (script[p].op !== "=") { p++; continue; }
        // Look ahead: are there any more changes within (2 * contextLines)?
        let look = p;
        let foundChange = false;
        const limit = Math.min(script.length, p + 2 * contextLines);
        while (look < limit) { if (script[look].op !== "=") { foundChange = true; break; } look++; }
        if (foundChange) { p++; continue; }
        // No more nearby changes — extend hunk by `contextLines` and stop
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
      // We don't track exact line offsets — these patches are for human
      // review only and never re-applied programmatically. Emit a
      // placeholder header so editors still recognize the file as a
      // unified diff.
      out += `@@ -? +? @@\n`;
      for (const s of hunk) {
        const prefix = s.op === "=" ? " " : s.op;
        out += `${prefix}${s.line}\n`;
      }
    }
    return out;
  }
}

CompositionMacroProcessor.MAPPING_RULES_DEFAULT = Object.freeze({
  deck: { newName: "tab-group", paramRenames: { id: "deckId" } },
  card: { newName: "tab", paramRenames: { label: "title" } },
});

module.exports = CompositionMacroProcessor;
