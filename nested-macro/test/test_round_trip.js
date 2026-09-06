#!/usr/bin/env node

/**
 * POC round-trip test — Phase 0 gate.
 *
 * Feeds a battery of Confluence-storage-format fragments through
 * storageFormatParser.parse() and .serialize(), then asserts that a
 * second parse of the serialized output produces the SAME tree
 * (semantic equivalence). Byte-exact equality is not required —
 * fast-xml-parser normalises some whitespace and attribute ordering —
 * but the semantic tree MUST round-trip.
 *
 * If this test fails, the whole plan is off the table: we'd need to
 * fall back to htmlparser2 direct or a different parser.
 */

const assert = require("assert");
const sfp = require("../src/storageFormatParser");

const fixtures = [
  {
    name: "plain text only",
    xml: "<p>hello world</p>",
  },
  {
    name: "empty paragraph",
    xml: "<p/>",
  },
  {
    name: "info macro with rich-text-body",
    xml:
      '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="abc-123">' +
      "<ac:rich-text-body><p>This is info.</p></ac:rich-text-body>" +
      "</ac:structured-macro>",
  },
  {
    name: "code macro with plain-text-body + CDATA",
    xml:
      '<ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="xyz">' +
      '<ac:parameter ac:name="language">javascript</ac:parameter>' +
      "<ac:plain-text-body><![CDATA[console.log('hi');\n  const x = 1;]]></ac:plain-text-body>" +
      "</ac:structured-macro>",
  },
  {
    name: "nested bodied macros (2-deep)",
    xml:
      '<ac:structured-macro ac:name="info" ac:macro-id="outer-1">' +
      "<ac:rich-text-body>" +
      "<p>before</p>" +
      '<ac:structured-macro ac:name="panel" ac:macro-id="inner-1">' +
      "<ac:rich-text-body><p>inside panel</p></ac:rich-text-body>" +
      "</ac:structured-macro>" +
      "<p>after</p>" +
      "</ac:rich-text-body>" +
      "</ac:structured-macro>",
  },
  {
    name: "3-deep nesting expand > info > note",
    xml:
      '<ac:structured-macro ac:name="expand" ac:macro-id="e1">' +
      "<ac:rich-text-body>" +
      '<ac:structured-macro ac:name="info" ac:macro-id="i1">' +
      "<ac:rich-text-body>" +
      '<ac:structured-macro ac:name="note" ac:macro-id="n1">' +
      "<ac:rich-text-body><p>deep</p></ac:rich-text-body>" +
      "</ac:structured-macro>" +
      "</ac:rich-text-body>" +
      "</ac:structured-macro>" +
      "</ac:rich-text-body>" +
      "</ac:structured-macro>",
  },
  {
    name: "xhtml entities (nbsp, ndash)",
    xml: "<p>foo&nbsp;bar&ndash;baz</p>",
  },
  {
    name: "ri: namespace (resource identifier)",
    xml:
      '<ac:link><ri:page ri:content-title="Target Page" ri:space-key="DEV"/>' +
      "<ac:plain-text-link-body><![CDATA[Link text]]></ac:plain-text-link-body></ac:link>",
  },
  {
    name: "user mention",
    xml: '<ac:link><ri:user ri:account-id="5c6a2abcd123456789"/></ac:link>',
  },
  {
    name: "image with attachment",
    xml:
      '<ac:image ac:alt="diagram" ac:title="Architecture">' +
      '<ri:attachment ri:filename="arch.png"/></ac:image>',
  },
  {
    name: "table with macro inside cell",
    xml:
      "<table><tbody><tr><td>" +
      '<ac:structured-macro ac:name="info" ac:macro-id="c1">' +
      "<ac:rich-text-body><p>cell info</p></ac:rich-text-body>" +
      "</ac:structured-macro>" +
      "</td></tr></tbody></table>",
  },
  {
    name: "CDATA containing literal structured-macro text (MUST NOT be parsed as nesting)",
    xml:
      '<ac:structured-macro ac:name="code" ac:macro-id="c2">' +
      '<ac:plain-text-body><![CDATA[<ac:structured-macro ac:name="fake"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>]]></ac:plain-text-body>' +
      "</ac:structured-macro>",
  },
  {
    name: "multiple sibling macros inside body",
    xml:
      '<ac:structured-macro ac:name="expand" ac:macro-id="out">' +
      "<ac:rich-text-body>" +
      '<ac:structured-macro ac:name="info" ac:macro-id="a"><ac:rich-text-body><p>A</p></ac:rich-text-body></ac:structured-macro>' +
      "<p>mid</p>" +
      '<ac:structured-macro ac:name="note" ac:macro-id="b"><ac:rich-text-body><p>B</p></ac:rich-text-body></ac:structured-macro>' +
      "</ac:rich-text-body>" +
      "</ac:structured-macro>",
  },
  {
    name: "layout with sections and columns",
    xml:
      '<ac:layout><ac:layout-section ac:type="two_equal">' +
      "<ac:layout-cell><p>left</p></ac:layout-cell>" +
      "<ac:layout-cell><p>right</p></ac:layout-cell>" +
      "</ac:layout-section></ac:layout>",
  },
  {
    name: "mixed content: text + macro + text",
    xml:
      "<p>before " +
      '<ac:structured-macro ac:name="status" ac:macro-id="s1">' +
      '<ac:parameter ac:name="colour">Green</ac:parameter>' +
      '<ac:parameter ac:name="title">OK</ac:parameter>' +
      "</ac:structured-macro>" +
      " after</p>",
  },
];

function treesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

let failures = 0;
let passes = 0;

console.log("Phase 0 — Storage-format round-trip POC\n");

for (const f of fixtures) {
  process.stdout.write(`  ${f.name.padEnd(72)} ... `);
  try {
    const tree1 = sfp.parse(f.xml);
    const serialized = sfp.serialize(tree1);
    const tree2 = sfp.parse(serialized);

    assert(treesEqual(tree1, tree2), "tree re-parse differs");

    // Second round-trip must be byte-identical (idempotence)
    const serialized2 = sfp.serialize(tree2);
    assert.strictEqual(serialized, serialized2, "second serialize differs");

    // For the CDATA false-positive case: confirm the inner literal text
    // is NOT parsed as a structured-macro — detection would be triggered
    // by the hasDescendantStructuredMacro walk.
    if (f.name.includes("CDATA containing literal")) {
      const outerMacro = tree1[0];
      const body = sfp.findChildByTag(outerMacro, "ac:plain-text-body");
      assert(body, "plain-text-body child missing");
      // There must be no ac:structured-macro node inside the CDATA body
      const bodyKids = sfp.getChildren(body.node);
      for (const k of bodyKids || []) {
        assert.notStrictEqual(sfp.getTag(k), "ac:structured-macro", "CDATA content was parsed as markup");
      }
    }

    console.log("OK");
    passes++;
  } catch (err) {
    console.log(`FAIL\n      ${err.message}`);
    failures++;
    if (process.env.POC_VERBOSE) {
      const tree1 = sfp.parse(f.xml);
      const serialized = sfp.serialize(tree1);
      console.log("      parsed:     " + JSON.stringify(tree1));
      console.log("      serialized: " + serialized);
    }
  }
}

console.log(`\n${passes} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);
