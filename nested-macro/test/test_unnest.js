#!/usr/bin/env node

/**
 * Unit tests for the un-nest algorithm.
 *
 * Each test parses a storage fixture, runs `detect`, runs `unnest`,
 * serialises back, and asserts on:
 *   - detection findings (which nestings were seen)
 *   - post-un-nest structural shape (top-level macro sequence)
 *   - that the serialised output parses cleanly (no broken XML)
 */

const assert = require("assert");
const sfp = require("../src/storageFormatParser");
const detector = require("../src/nestedMacroDetector");
const processor = require("../src/unnestProcessor");

let passes = 0;
let failures = 0;
const failureDetails = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  OK    ${name}`);
    passes++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures++;
    failureDetails.push({ name, err });
  }
}

/** Return the tag+macro-name sequence of top-level nodes for assertions. */
function shape(tree) {
  return tree.map((n) => {
    const tag = sfp.getTag(n);
    if (tag === "ac:structured-macro" || tag === "ac:macro") return `macro:${sfp.getMacroName(n)}`;
    if (tag === null && typeof n["#text"] === "string") {
      return `text:${n["#text"].replace(/\s+/g, " ").trim()}`;
    }
    return tag;
  });
}

// ─────────────────────────────────────────────────────────────────────

console.log("\n--- nestedMacroDetector ---\n");

test("detects 2-deep info > panel", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>hi</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  const findings = detector.detect(tree);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].outerMacro, "info");
  assert.strictEqual(findings[0].innerMacro, "panel");
  assert.strictEqual(findings[0].depth, 2);
});

test("detects 3-deep expand > info > note", () => {
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="a"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="b"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="c"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  const findings = detector.detect(tree);
  // expand > info (depth 2), info > note (depth 3)
  assert.strictEqual(findings.length, 2);
  const depths = findings.map((f) => f.depth).sort();
  assert.deepStrictEqual(depths, [2, 3]);
});

test("detects macro buried inside a <p> inside rich-text-body", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    '<p>before <ac:structured-macro ac:name="status" ac:macro-id="s"><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro> after</p>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const findings = detector.detect(sfp.parse(xml));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].outerMacro, "info");
  assert.strictEqual(findings[0].innerMacro, "status");
});

test("ignores macros inside plain-text-body CDATA (false-positive guard)", () => {
  const xml =
    '<ac:structured-macro ac:name="code" ac:macro-id="c">' +
    '<ac:plain-text-body><![CDATA[<ac:structured-macro ac:name="fake"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>]]></ac:plain-text-body>' +
    "</ac:structured-macro>";
  const findings = detector.detect(sfp.parse(xml));
  assert.strictEqual(findings.length, 0, "CDATA content must not be parsed as markup");
});

test("no nestings for flat content", () => {
  const xml =
    "<p>hello</p>" +
    '<ac:structured-macro ac:name="info" ac:macro-id="1"><ac:rich-text-body><p>a</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="2"><ac:rich-text-body><p>b</p></ac:rich-text-body></ac:structured-macro>';
  assert.strictEqual(detector.detect(sfp.parse(xml)).length, 0);
});

test("multi-sibling inside outer body reports two findings", () => {
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="o"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="a"><ac:rich-text-body><p>A</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="b"><ac:rich-text-body><p>B</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const findings = detector.detect(sfp.parse(xml));
  assert.strictEqual(findings.length, 2);
  assert.deepStrictEqual(
    findings.map((f) => f.innerMacro).sort(),
    ["info", "note"],
  );
});

// ─────────────────────────────────────────────────────────────────────

console.log("\n--- unnestProcessor: split-around-child ---\n");

test("2-deep info > panel → info + panel (panel extracted, info body empty so dropped)", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // Both halves of info were empty, so info collapses entirely.
  assert.deepStrictEqual(shape(tree), ["macro:panel"]);
});

test("info[pre + panel + post] → info(pre) + panel + info(post)", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    "<p>before</p>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>after</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  assert.deepStrictEqual(shape(tree), ["macro:info", "macro:panel", "macro:info"]);

  // Verify body contents of the two info halves
  const firstInfo = tree[0];
  const firstBody = sfp.findChildByTag(firstInfo, "ac:rich-text-body");
  const firstKids = sfp.getChildren(firstBody.node);
  assert.strictEqual(firstKids.length, 1);
  assert.strictEqual(sfp.getTag(firstKids[0]), "p");

  const secondInfo = tree[2];
  const secondBody = sfp.findChildByTag(secondInfo, "ac:rich-text-body");
  const secondKids = sfp.getChildren(secondBody.node);
  assert.strictEqual(secondKids.length, 1);
  assert.strictEqual(sfp.getTag(secondKids[0]), "p");
});

test("3-deep expand > info > note → three siblings", () => {
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="a"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="b"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="c"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // All intermediate wrappers had no content besides their inner macro;
  // they all collapse to just note.
  assert.deepStrictEqual(shape(tree), ["macro:note"]);
});

test("expand[pre + info[note] + post] → expand(pre) + note + expand(post) after iteration", () => {
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="a"><ac:rich-text-body>' +
    "<p>x</p>" +
    '<ac:structured-macro ac:name="info" ac:macro-id="b"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="c"><ac:rich-text-body><p>n</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>" +
    "<p>y</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // Pass 1: expand splits around info → [expand(x), info[note], expand(y)]
  // Pass 2: info has note inside and empty halves → collapses to note.
  assert.deepStrictEqual(shape(tree), ["macro:expand", "macro:note", "macro:expand"]);
});

test("multi-sibling: expand[infoA, text, noteB] → expand(),infoA,expand(text),noteB,expand()", () => {
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="o"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="a"><ac:rich-text-body><p>A</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>mid</p>" +
    '<ac:structured-macro ac:name="note" ac:macro-id="b"><ac:rich-text-body><p>B</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // First split: expand splits around info → [info, expand(mid + note)]
  //   (before half empty → dropped)
  // Second split: expand splits around note → [info, expand(mid), note]
  //   (after half empty → dropped)
  assert.deepStrictEqual(shape(tree), ["macro:info", "macro:expand", "macro:note"]);
});

test("idempotence: a second unnest pass over already-flat content changes nothing", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="1"><ac:rich-text-body><p>a</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="note" ac:macro-id="2"><ac:rich-text-body><p>b</p></ac:rich-text-body></ac:structured-macro>';
  const tree = sfp.parse(xml);
  const before = JSON.stringify(tree);
  processor.unnest(tree);
  assert.strictEqual(JSON.stringify(tree), before, "flat content should not change");
});

test("round-trip serialisation after un-nest", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    "<p>before</p>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>after</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  const serialised = sfp.serialize(tree);
  // Re-parse must succeed and yield equivalent tree
  const reparsed = sfp.parse(serialised);
  assert.deepStrictEqual(reparsed, tree, "serialised output must round-trip");
  // And the detector must see no remaining nestings.
  assert.strictEqual(detector.detect(reparsed).length, 0, "no nestings should remain");
});

test("refreshed macro-ids on clones (no duplicate ac:macro-id)", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="original"><ac:rich-text-body>' +
    "<p>A</p>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="inner"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>B</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  const macroIds = [];
  for (const n of tree) {
    if (sfp.isStructuredMacro(n)) {
      const id = sfp.getAttr(n, "ac:macro-id");
      if (id) macroIds.push(id);
    }
  }
  const uniq = new Set(macroIds);
  assert.strictEqual(uniq.size, macroIds.length, `duplicate ac:macro-ids: ${macroIds}`);
});

// ─────────────────────────────────────────────────────────────────────

console.log("\n--- unnestProcessor: excluded-parent fallback ---\n");

test("info inside column — default 'skip' leaves structure alone", () => {
  // column is an excluded container; info is inside column.
  // We're testing: if the OUTER macro is column (excluded) and contains
  // info, we don't split column. But if info itself contained a nested
  // macro, we'd happily un-nest inside info. This fixture has info-in-column
  // with info containing NOTHING nested — so no changes expected.
  const xml =
    '<ac:structured-macro ac:name="column" ac:macro-id="c"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="i"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  const before = JSON.stringify(tree);
  processor.unnest(tree, { fallbackStrategy: "skip" });
  assert.strictEqual(JSON.stringify(tree), before, "skip should leave column-info intact");
});

test("column with info[panel] — info inside column gets un-nested, column is skipped", () => {
  const xml =
    '<ac:structured-macro ac:name="column" ac:macro-id="c"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="info" ac:macro-id="i"><ac:rich-text-body>' +
    '<ac:structured-macro ac:name="panel" ac:macro-id="p"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree, { fallbackStrategy: "skip" });
  // The inner info>panel nesting should be un-nested: info collapses to panel.
  // column remains at top; its body now contains only panel.
  assert.deepStrictEqual(shape(tree), ["macro:column"]);
  const col = tree[0];
  const colBody = sfp.findChildByTag(col, "ac:rich-text-body");
  const colKids = sfp.getChildren(colBody.node);
  // After un-nesting, info was removed; panel stays inside column.
  const macroKids = colKids.filter((k) => sfp.isStructuredMacro(k));
  assert.strictEqual(macroKids.length, 1);
  assert.strictEqual(sfp.getMacroName(macroKids[0]), "panel");
});

test("excluded 'promote' fallback unwraps column, inner macro becomes sibling", () => {
  const xml =
    '<ac:structured-macro ac:name="column" ac:macro-id="c"><ac:rich-text-body>' +
    "<p>col-pre</p>" +
    '<ac:structured-macro ac:name="info" ac:macro-id="i"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>' +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree, { fallbackStrategy: "promote" });
  // column gets unwrapped → its body contents are inlined.
  assert.deepStrictEqual(shape(tree), ["p", "macro:info"]);
});

// ─────────────────────────────────────────────────────────────────────

console.log("\n--- edge cases ---\n");

test("legacy ac:macro form is detected as a macro (equivalent to ac:structured-macro)", () => {
  const xml =
    '<ac:macro ac:name="panel"><ac:rich-text-body>' +
    '<ac:macro ac:name="contentbylabel"><ac:parameter ac:name="labels">x</ac:parameter></ac:macro>' +
    "</ac:rich-text-body></ac:macro>";
  const findings = detector.detect(sfp.parse(xml));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].outerMacro, "panel");
  assert.strictEqual(findings[0].innerMacro, "contentbylabel");
});

test("mixed ac:macro + ac:structured-macro nesting handled by un-nest", () => {
  const xml =
    '<ac:structured-macro ac:name="panel" ac:macro-id="outer"><ac:rich-text-body>' +
    "<p>pre</p>" +
    '<ac:macro ac:name="contentbylabel"><ac:parameter ac:name="labels">x</ac:parameter></ac:macro>' +
    "<p>post</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // panel (outer, structured-macro) should be split around the legacy ac:macro inner.
  assert.deepStrictEqual(shape(tree), ["macro:panel", "macro:contentbylabel", "macro:panel"]);
});

test("code macro (plain-text-body) contains no nesting even with literal markup text", () => {
  const xml =
    '<ac:structured-macro ac:name="code" ac:macro-id="c">' +
    '<ac:plain-text-body><![CDATA[<ac:structured-macro ac:name="fake"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>]]></ac:plain-text-body>' +
    "</ac:structured-macro>";
  const tree = sfp.parse(xml);
  const before = JSON.stringify(tree);
  processor.unnest(tree);
  assert.strictEqual(JSON.stringify(tree), before, "code macro should not be modified");
});

test("split preserves <ac:parameter> siblings on BOTH halves (regression)", () => {
  // The classic "parameter loss" bug: the split-around-child rebuild was
  // putting parameters only on the BEFORE half, dropping them from AFTER.
  // Real-world fallout: panel bgColor/title, expand title, info icon all
  // lost on the second clone after a split.
  const xml =
    '<ac:structured-macro ac:name="panel" ac:macro-id="o">' +
    '<ac:parameter ac:name="bgColor">#FF0000</ac:parameter>' +
    '<ac:parameter ac:name="title">Outer Panel</ac:parameter>' +
    "<ac:rich-text-body>" +
    "<p>before</p>" +
    '<ac:structured-macro ac:name="info" ac:macro-id="i"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>after</p>" +
    "</ac:rich-text-body>" +
    "</ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // Expect: panel(before) + info + panel(after)
  assert.deepStrictEqual(shape(tree), ["macro:panel", "macro:info", "macro:panel"]);

  // Both panel halves must carry both parameters.
  const collectParams = (macro) => {
    const params = {};
    for (const child of sfp.getChildren(macro) || []) {
      if (sfp.getTag(child) === "ac:parameter") {
        const name = sfp.getAttr(child, "ac:name");
        const kids = sfp.getChildren(child) || [];
        const text = kids.find((k) => typeof k["#text"] === "string");
        params[name] = text ? text["#text"] : "";
      }
    }
    return params;
  };
  const beforePanel = tree[0];
  const afterPanel = tree[2];
  assert.deepStrictEqual(collectParams(beforePanel), { bgColor: "#FF0000", title: "Outer Panel" }, "BEFORE panel must keep params");
  assert.deepStrictEqual(collectParams(afterPanel),  { bgColor: "#FF0000", title: "Outer Panel" }, "AFTER panel must keep params");
});

test("split preserves params through deep nesting (3-deep, parameters at every level)", () => {
  // expand[title=Outer] > panel[bgColor=blue] > info[icon=true]
  // Each wrapper has prefix+suffix content alongside its child macro so its
  // halves survive the substance check; after full un-nest, every wrapper
  // clone at every level must still carry its parameters on both sides.
  const xml =
    '<ac:structured-macro ac:name="expand" ac:macro-id="o">' +
    '<ac:parameter ac:name="title">Outer Expand</ac:parameter>' +
    "<ac:rich-text-body>" +
    "<p>expand-pre</p>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="m">' +
    '<ac:parameter ac:name="bgColor">blue</ac:parameter>' +
    "<ac:rich-text-body>" +
    "<p>panel-pre</p>" +
    '<ac:structured-macro ac:name="info" ac:macro-id="i">' +
    '<ac:parameter ac:name="icon">true</ac:parameter>' +
    "<ac:rich-text-body><p>info-body</p></ac:rich-text-body>" +
    "</ac:structured-macro>" +
    "<p>panel-post</p>" +
    "</ac:rich-text-body>" +
    "</ac:structured-macro>" +
    "<p>expand-post</p>" +
    "</ac:rich-text-body>" +
    "</ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);

  // After full un-nest: every wrapper clone at the top level must carry its
  // own parameters. Walk all top-level macros, collect their params, then
  // assert.
  const collectParams = (macro) => {
    const params = {};
    for (const child of sfp.getChildren(macro) || []) {
      if (sfp.getTag(child) === "ac:parameter") {
        const pname = sfp.getAttr(child, "ac:name");
        const kids = sfp.getChildren(child) || [];
        const text = kids.find((k) => typeof k["#text"] === "string");
        params[pname] = text ? text["#text"] : "";
      }
    }
    return params;
  };
  const seenParams = { panel: [], expand: [], info: [] };
  for (const n of tree) {
    if (!sfp.isStructuredMacro(n)) continue;
    const name = sfp.getMacroName(n);
    if (seenParams[name]) seenParams[name].push(collectParams(n));
  }

  assert.ok(seenParams.expand.length >= 1, "expected at least one expand clone");
  for (const p of seenParams.expand) {
    assert.strictEqual(p.title, "Outer Expand", `expand clone missing title: ${JSON.stringify(p)}`);
  }
  assert.ok(seenParams.panel.length >= 1, "expected at least one panel clone");
  for (const p of seenParams.panel) {
    assert.strictEqual(p.bgColor, "blue", `panel clone missing bgColor: ${JSON.stringify(p)}`);
  }
  assert.ok(seenParams.info.length >= 1, "expected info to surface at top level");
  for (const p of seenParams.info) {
    assert.strictEqual(p.icon, "true", `info clone missing icon: ${JSON.stringify(p)}`);
  }
});

test("CDATA-only body half is preserved (not dropped as 'empty')", () => {
  // Body containing literal CDATA + an inner macro + tail text. The CDATA
  // sits before the inner macro; the BEFORE half therefore has only CDATA.
  // subtreeHasSubstance must recognise CDATA as content, not drop it.
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    "<![CDATA[some literal cdata text]]>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>after</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  processor.unnest(tree);
  // Should produce: info(cdata-only), panel, info(p-after)
  assert.deepStrictEqual(shape(tree), ["macro:info", "macro:panel", "macro:info"]);
  // The first info's body must still contain the CDATA node.
  const beforeInfo = tree[0];
  const beforeBody = sfp.findChildByTag(beforeInfo, "ac:rich-text-body");
  const bodyKids = sfp.getChildren(beforeBody.node) || [];
  const cdataKids = bodyKids.filter((k) => Array.isArray(k.__cdata));
  assert.strictEqual(cdataKids.length, 1, "BEFORE half must keep its CDATA child");
});

test("stats reflect work done", () => {
  const xml =
    '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
    "<p>pre</p>" +
    '<ac:structured-macro ac:name="panel" ac:macro-id="p"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
    "<p>post</p>" +
    "</ac:rich-text-body></ac:structured-macro>";
  const tree = sfp.parse(xml);
  const { stats } = processor.unnest(tree);
  assert.strictEqual(stats.changes, 1);
  assert.ok(stats.passes >= 1);
});

// ─────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed.\n`);
if (failures > 0) {
  console.log("Failure details:");
  for (const { name, err } of failureDetails) {
    console.log(`  ${name}:\n    ${err.stack || err.message}`);
  }
  process.exit(1);
}
