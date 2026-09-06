#!/usr/bin/env node

/**
 * verify_conversions.js
 *
 * Post-conversion verifier for aura-user-profile pages. For each page,
 * fetches storage + ADF + (optionally) body.view and runs a battery of
 * structural checks that correlate with editor-mode failures. Outputs
 * a per-page report and an overall pass/fail.
 *
 * Checks performed (extend as new failure modes are discovered):
 *
 *   STORAGE
 *     S1. aura macro is present (at least one)
 *     S2. responsible-person-macro is GONE (no leftovers)
 *     S3. NOT inside a <p>...</p> wrapper (block-in-inline = editor breaks)
 *     S4. NOT inside <span> / <em> / <strong> / <a> (any inline parent)
 *     S5. immediately preceded by a self-closing <p /> placeholder
 *         IF inside a layout-cell (matches the known-good sample shape)
 *
 *   ADF (atlas_doc_format)
 *     A1. aura extension is present
 *     A2. extension has expected attrs (extensionKey, layout)
 *     A3. extension is NOT nested inside a paragraph node (block in inline)
 *
 *   PARAMS JSON
 *     P1. base64-decodable, valid JSON
 *     P2. cards is an array
 *     P3. each card has all expected keys: image, imageType, info, user, backgroundColor
 *     P4. card key ORDER matches the working sample
 *     P5. each card.user looks like a valid Cloud accountId
 *     P6. top-level keys present: cards, cardSize, cardStyle, hover, shapeColor, nameColor, fontColor
 *
 *   VIEW (optional, requires --check-view)
 *     V1. rendered HTML contains the Aura iframe wrapper
 *     V2. no "unknown macro" placeholder referencing aura
 *
 * USAGE
 *   node main/verify_conversions.js --space TEAM
 *   node main/verify_conversions.js --space TEAM,AIRM,GAI
 *   node main/verify_conversions.js --cloud-page-id 288063573,288064313
 *   node main/verify_conversions.js --space TEAM --check-view
 *   node main/verify_conversions.js --space TEAM --json    # machine-readable report
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudConfluenceClient = require("../src/cloudConfluenceClient");

const EXPECTED_CARD_KEYS = ["image", "imageType", "info", "user", "backgroundColor"];
const EXPECTED_TOP_KEYS = ["cards", "cardSize", "cardStyle", "hover", "shapeColor", "nameColor", "fontColor"];
const ACCOUNT_ID_RE = /^(?:[0-9]+:[a-f0-9-]{8,}|[a-f0-9]{24,})$/i;
const INLINE_PARENTS = ["p", "span", "em", "strong", "i", "b", "u", "a"];

function parseArgs(argv) {
  const o = { space: null, all: false, cloudPageIds: [], checkView: false, json: false, limit: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--space": o.space = argv[++i]; break;
      case "--all": o.all = true; break;
      case "--cloud-page-id": {
        const v = argv[++i];
        if (v) o.cloudPageIds.push(...v.split(",").map(s => s.trim()).filter(Boolean));
        break;
      }
      case "--check-view": o.checkView = true; break;
      case "--json": o.json = true; break;
      case "--limit": o.limit = parseInt(argv[++i], 10) || 0; break;
      case "--help":
      case "-h": o.help = true; break;
    }
  }
  return o;
}

function help() {
  console.log(`
Usage: node main/verify_conversions.js [--space KEY | --all | --cloud-page-id IDs] [options]

  --space K[,K]        verify aura pages in these space(s)
  --all                verify across every space
  --cloud-page-id IDs  verify specific Cloud pageIds
  --check-view         also fetch body.view (slower) for view-mode checks
  --json               machine-readable JSON report on stdout
  --limit N            cap pages checked
`);
}

// ─── Storage scanner ─────────────────────────────────────────────────

const STRUCT_OPEN = "<ac:structured-macro";
const STRUCT_CLOSE = "</ac:structured-macro>";

function findAuraMacroSpans(xml) {
  const out = [];
  let i = 0;
  while (true) {
    const idx = xml.indexOf(`${STRUCT_OPEN} ac:name="aura-user-profile"`, i);
    if (idx === -1) break;
    const closeIdx = xml.indexOf(STRUCT_CLOSE, idx);
    if (closeIdx === -1) break;
    const end = closeIdx + STRUCT_CLOSE.length;
    out.push([idx, end]);
    i = end;
  }
  return out;
}

function countResponsibilityMacros(xml) {
  return (xml.match(/<ac:structured-macro ac:name="responsible-person-macro"/g) || []).length;
}

/**
 * Walk backward from `idx` (allowing whitespace) and return the
 * immediately preceding tag info: { tagName, isSelfClose, isClosing,
 * fullTag } or null if no tag found.
 */
function priorTag(xml, idx) {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(xml[i])) i--;
  if (i < 0 || xml[i] !== ">") return null;
  const tagOpenIdx = xml.lastIndexOf("<", i);
  if (tagOpenIdx === -1) return null;
  const tag = xml.substring(tagOpenIdx, i + 1);
  const isClosing = tag.startsWith("</");
  const isSelfClose = tag.endsWith("/>") && !isClosing;
  const nameMatch = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9:.\-]*)/);
  return {
    tagName: nameMatch ? nameMatch[1].toLowerCase() : null,
    isSelfClose,
    isClosing,
    fullTag: tag,
    start: tagOpenIdx,
  };
}

/**
 * Find the nearest unclosed ancestor element name of a position.
 * Returns the local element name (lowercased, no namespace) or null.
 * Naive — doesn't account for self-closing tags inside.
 */
function findInlineParent(xml, idx) {
  // Walk backward looking for the most recent OPEN tag whose matching
  // close tag is AFTER idx. We only need to know the immediate parent
  // among inline-only elements.
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:.\-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null && m.index < idx) {
    const isClosing = m[1] === "/";
    const isSelfClose = m[3] === "/" || /\/$/.test(m[0].slice(0, -1));
    const name = m[2].toLowerCase();
    // Skip CDATA/comments/PIs (none expected here)
    if (isSelfClose) continue;
    if (isClosing) {
      // Pop matching open
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === name) { stack.splice(k, 1); break; }
      }
    } else {
      stack.push(name);
    }
  }
  // Inline parents are the deepest in stack — return the last one
  // matching INLINE_PARENTS
  for (let k = stack.length - 1; k >= 0; k--) {
    if (INLINE_PARENTS.includes(stack[k])) return stack[k];
  }
  return null;
}

/**
 * Whether the macro at [start, end] is inside a layout-cell ancestor.
 */
function insideLayoutCell(xml, idx) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:.\-]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null && m.index < idx) {
    const isClosing = m[1] === "/";
    const isSelfClose = m[3] === "/" || m[0].endsWith("/>");
    const name = m[2].toLowerCase();
    if (isSelfClose) continue;
    if (isClosing) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === name) { stack.splice(k, 1); break; }
      }
    } else {
      stack.push(name);
    }
  }
  return stack.includes("ac:layout-cell");
}

// ─── ADF scanner ─────────────────────────────────────────────────────

function findAuraExtensionsInAdf(adf) {
  const out = [];
  function walk(node, parentType) {
    if (!node) return;
    if (
      (node.type === "extension" || node.type === "bodiedExtension" || node.type === "inlineExtension")
      && (node.attrs?.extensionKey === "aura-user-profile" || (node.attrs?.extensionKey || "").includes("aura-user-profile"))
    ) {
      out.push({ node, parentType });
    }
    if (Array.isArray(node.content)) node.content.forEach((c) => walk(c, node.type));
  }
  walk(adf, null);
  return out;
}

// ─── Per-page verifier ───────────────────────────────────────────────

async function verifyPage(client, pageId, opts) {
  const checks = [];
  const fail = (code, label, detail) => checks.push({ pass: false, code, label, detail });
  const pass = (code, label) => checks.push({ pass: true, code, label });

  let page;
  try {
    const expand = opts.checkView ? "body.storage,body.atlas_doc_format,body.view,version,space" : "body.storage,body.atlas_doc_format,version,space";
    page = await client.makeRequest("GET", `/rest/api/content/${pageId}?expand=${expand}`);
  } catch (e) {
    return { pageId, title: "?", error: e.message, checks: [] };
  }
  const xml = page.body?.storage?.value || "";
  const adfStr = page.body?.atlas_doc_format?.value || "";
  const viewHtml = page.body?.view?.value || "";

  // ── STORAGE checks ──
  const auras = findAuraMacroSpans(xml);
  if (auras.length === 0) fail("S1", "aura macro present", "no aura-user-profile macro in storage");
  else pass("S1", "aura macro present");

  const respCount = countResponsibilityMacros(xml);
  if (respCount > 0) fail("S2", "responsible-person-macro gone", `${respCount} leftover responsible-person-macro(s)`);
  else pass("S2", "responsible-person-macro gone");

  for (const [start, end] of auras) {
    const inLayoutCell = insideLayoutCell(xml, start);
    const inlineParent = findInlineParent(xml, start);

    // S3: not inside <p>
    if (inlineParent === "p") fail("S3", "macro NOT inside <p>", `aura macro at offset ${start} is wrapped in <p>...</p>`);
    else pass("S3", "macro NOT inside <p>");

    // S4: not inside other inline elements
    if (inlineParent && inlineParent !== "p") fail("S4", `macro NOT inside <${inlineParent}>`, `aura macro inside inline element <${inlineParent}>`);
    else pass("S4", "macro NOT inside other inline element");

    // S5: if in layout-cell, has <p /> placeholder before it
    if (inLayoutCell) {
      const prior = priorTag(xml, start);
      const isPlaceholderP = prior && prior.tagName === "p" && prior.isSelfClose;
      if (!isPlaceholderP) {
        // Acceptable alternatives: another block element (h2, h3, etc.) or another close
        // Only flag as suspect if the immediate prior tag is unusual or missing
        if (prior && !["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(prior.tagName) && !prior.isClosing) {
          fail("S5", "layout-cell macro has <p /> or block-header before it", `prior tag: ${prior.fullTag.substring(0, 80)}`);
        } else {
          pass("S5", "layout-cell macro has acceptable prior tag");
        }
      } else {
        pass("S5", "layout-cell macro has <p /> placeholder");
      }
    }
  }

  // ── ADF checks ──
  let adf = null;
  if (adfStr) {
    try { adf = JSON.parse(adfStr); } catch (e) { fail("A0", "ADF parseable", e.message); }
  } else { fail("A0", "ADF available", "no atlas_doc_format body"); }

  if (adf) {
    const adfAuras = findAuraExtensionsInAdf(adf);
    if (adfAuras.length === 0) fail("A1", "aura extension present in ADF", "");
    else pass("A1", "aura extension present in ADF");

    for (const { node, parentType } of adfAuras) {
      const attrs = node.attrs || {};
      if (attrs.extensionKey === "aura-user-profile" && attrs.layout) pass("A2", "ADF extension has expected attrs");
      else fail("A2", "ADF extension attrs", JSON.stringify({extensionKey: attrs.extensionKey, layout: attrs.layout}));

      if (parentType === "paragraph") fail("A3", "ADF aura NOT inside paragraph node", `parent type was 'paragraph' — editor will reject`);
      else pass("A3", "ADF aura at valid level");

      // ── PARAMS JSON ──
      const paramsB64 = attrs.parameters?.macroParams?.params?.value;
      if (paramsB64) {
        let decoded;
        try { decoded = JSON.parse(decodeURIComponent(Buffer.from(paramsB64, "base64").toString("utf8"))); pass("P1", "params decodable"); }
        catch (e) { fail("P1", "params decodable", e.message); }
        if (decoded) {
          if (Array.isArray(decoded.cards)) pass("P2", "cards is array");
          else fail("P2", "cards is array", typeof decoded.cards);
          if (Array.isArray(decoded.cards)) {
            let cardKeyOrderOk = true, accountIdOk = true;
            for (let i = 0; i < decoded.cards.length; i++) {
              const c = decoded.cards[i];
              const keys = Object.keys(c);
              if (keys.length !== EXPECTED_CARD_KEYS.length || !EXPECTED_CARD_KEYS.every((k, j) => keys[j] === k)) {
                cardKeyOrderOk = false;
                fail("P4", `card[${i}] key order matches expected`, `got [${keys.join(",")}]`);
                break;
              }
              if (!c.user || !ACCOUNT_ID_RE.test(c.user)) {
                accountIdOk = false;
                fail("P5", `card[${i}] accountId valid`, `got ${JSON.stringify(c.user)}`);
                break;
              }
            }
            if (cardKeyOrderOk) pass("P3+P4", "all cards have all expected keys in order");
            if (accountIdOk) pass("P5", "all card accountIds valid");
          }
          for (const k of EXPECTED_TOP_KEYS) {
            if (!(k in decoded)) fail("P6", `top-level key '${k}'`, "missing");
          }
        }
      } else {
        fail("P0", "params field present", "no macroParams.params.value in ADF");
      }
    }
  }

  // ── VIEW checks ──
  if (opts.checkView && viewHtml) {
    if (viewHtml.includes("data-macro-name=\"aura-user-profile\"")) pass("V1", "Aura iframe rendered in view");
    else fail("V1", "Aura iframe rendered in view", "no data-macro-name=aura-user-profile div");
    if (/unknown-macro/.test(viewHtml) && viewHtml.includes("aura-user-profile")) fail("V2", "no 'unknown macro' near aura", "");
    else pass("V2", "no 'unknown macro' near aura");
  }

  return { pageId, title: page.title, version: page.version?.number, space: page.space?.key, checks };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); process.exit(0); }
  if (!opts.space && !opts.all && opts.cloudPageIds.length === 0) { console.error("Need --space, --all, or --cloud-page-id"); help(); process.exit(1); }
  if (!process.env.CLOUD_BASE_URL || !process.env.CLOUD_EMAIL || !process.env.CLOUD_API_TOKEN) {
    console.error("Missing CLOUD_BASE_URL/CLOUD_EMAIL/CLOUD_API_TOKEN in .env"); process.exit(1);
  }
  const client = new CloudConfluenceClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);

  // Discover targets
  let targets = [];
  if (opts.cloudPageIds.length) {
    targets = opts.cloudPageIds.slice();
  } else {
    const cql = opts.space
      ? `space in (${opts.space.split(",").map(s => `"${s.trim()}"`).join(",")}) AND macro = "aura-user-profile" AND type = page ORDER BY id`
      : `macro = "aura-user-profile" AND type = page ORDER BY id`;
    await client.searchContentByCql(cql, "version,space", async (results) => {
      for (const p of results) {
        targets.push(String(p.id));
        if (opts.limit > 0 && targets.length >= opts.limit) return false;
      }
    });
  }

  if (!opts.json) console.log(`Verifying ${targets.length} aura page(s)...\n`);

  const reports = [];
  let totalPass = 0, totalFail = 0;
  for (const id of targets) {
    const rep = await verifyPage(client, id, opts);
    reports.push(rep);
    if (rep.error) { totalFail++; if (!opts.json) console.log(`  ${id} ERROR: ${rep.error}`); continue; }
    const failed = rep.checks.filter(c => !c.pass);
    if (failed.length === 0) {
      totalPass++;
      if (!opts.json) console.log(`  ✓ ${rep.pageId} v${rep.version} "${rep.title}" — ${rep.checks.length} checks PASS`);
    } else {
      totalFail++;
      if (!opts.json) {
        console.log(`  ✗ ${rep.pageId} v${rep.version} "${rep.title}" — ${failed.length} CHECK(S) FAILED:`);
        for (const c of failed) console.log(`      [${c.code}] ${c.label}: ${c.detail}`);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ summary: { totalPass, totalFail }, reports }, null, 2));
  } else {
    console.log(`\n=== Summary ===`);
    console.log(`PASS: ${totalPass}   FAIL: ${totalFail}`);
  }
  process.exit(totalFail === 0 ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
