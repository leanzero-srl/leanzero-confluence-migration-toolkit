#!/usr/bin/env node

/**
 * test_rewrite_fixtures.js
 *
 * Offline test runner for ResponsibilityMacroProcessor. Each fixture is
 * a stand-alone scenario exercising one branch of the engine:
 *   - findCandidateMacros discovers the source macro
 *   - extractUserTokens reads users from <ri:user> tags or CSV text
 *   - buildAuraReplacement chunks at maxUsersPerAura
 *   - rewriteStorage splices in the right place, back-to-front
 *
 * IMPORTANT: these fixtures use PLACEHOLDER ac:name values
 * ("responsibility" / "aura-user-profile") and the default users-param
 * shape. Once the user provides real Cloud-page XML samples, replace the
 * fixtures with the real macro shapes so the tests double as regression
 * coverage for the actual rewrite behavior.
 *
 * Run:  node test/test_rewrite_fixtures.js
 */

"use strict";

const ResponsibilityMacroProcessor = require("../src/responsibilityMacroProcessor");

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

function assertContains(haystack, needle, label) {
  if (typeof haystack === "string" && haystack.includes(needle)) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
    console.log(`        needle:   ${JSON.stringify(needle)}`);
    console.log(`        haystack: ${JSON.stringify(String(haystack).substring(0, 400))}`);
  }
}

// ─── Fixture A: extract tokens from <ri:user ri:account-id="..."/> ───
(() => {
  console.log("\nFixture A: extract tokens — <ri:user ri:account-id=.../>");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<p>before</p>',
    '<ac:structured-macro ac:name="responsible-person-macro" ac:schema-version="1" ac:macro-id="aaaa-1111">',
    '  <ac:parameter ac:name="users"><ri:user ri:account-id="557058:alice" /><ri:user ri:account-id="557058:bob" /></ac:parameter>',
    '</ac:structured-macro>',
    '<p>after</p>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  assertEq(instances.length, 1, "A.1 finds 1 instance");
  assertEq(instances[0].name, "responsible-person-macro", "A.2 name = responsible-person-macro");
  assertEq(instances[0].macroId, "aaaa-1111", "A.3 macroId captured");
  const tokens = p.extractUserTokens(instances[0]);
  assertEq(tokens.length, 2, "A.4 extracts 2 tokens");
  assertEq(tokens[0], "557058:alice", "A.5 first token");
  assertEq(tokens[1], "557058:bob",   "A.6 second token");
})();

// ─── Fixture B: extract tokens from <ri:user ri:userkey="..."/> ───
(() => {
  console.log("\nFixture B: extract tokens — <ri:user ri:userkey=.../>");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="bbbb-2222">',
    '<ac:parameter ac:name="users"><ri:user ri:userkey="ff8080812abc" /><ri:user ri:userkey="ff8080812def" /></ac:parameter>',
    '</ac:structured-macro>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  const tokens = p.extractUserTokens(instances[0]);
  assertEq(tokens[0], "ff8080812abc", "B.1 first userkey");
  assertEq(tokens[1], "ff8080812def", "B.2 second userkey");
})();

// ─── Fixture C: extract tokens from comma-separated text ───
(() => {
  console.log("\nFixture C: extract tokens — comma-separated text");
  const p = new ResponsibilityMacroProcessor();
  const xml =
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="cccc-3333">' +
    '<ac:parameter ac:name="users">alice, bob ,carol</ac:parameter>' +
    '</ac:structured-macro>';
  const instances = p.findCandidateMacros(xml);
  const tokens = p.extractUserTokens(instances[0]);
  assertEq(tokens.length, 3, "C.1 three tokens");
  assertEq(tokens[0], "alice", "C.2 trimmed alice");
  assertEq(tokens[1], "bob",   "C.3 trimmed bob");
  assertEq(tokens[2], "carol", "C.4 trimmed carol");
})();

// ─── Fixture D: rewrite one macro with 2 users (one chunk) ───
(() => {
  console.log("\nFixture D: rewrite one macro, 2 users (one Aura chunk)");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<p>before</p>',
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="dddd-4444">',
    '<ac:parameter ac:name="users"><ri:user ri:account-id="A1" /><ri:user ri:account-id="A2" /></ac:parameter>',
    '</ac:structured-macro>',
    '<p>after</p>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  const accountIdsByKey = { "mid:dddd-4444": ["A1", "A2"] };
  const { newXml, changes } = p.rewriteStorage(xml, instances, accountIdsByKey);
  assertEq(changes.length, 1, "D.1 one change");
  assertEq(changes[0].chunks, 1, "D.2 one chunk");
  assertContains(newXml, '<p>before</p>', "D.3 preserves before");
  assertContains(newXml, '<p>after</p>',  "D.4 preserves after");
  assertContains(newXml, '<ac:structured-macro ac:name="aura-user-profile"', "D.5 emits aura macro");
  assertContains(newXml, '<ac:parameter ac:name="users">A1,A2</ac:parameter>', "D.6 CSV users param");
  // Source macro should be gone
  assertEq(newXml.includes('ac:name="responsible-person-macro"'), false, "D.7 source macro gone");
})();

// ─── Fixture E: chunk at maxUsersPerAura=10 ───
(() => {
  console.log("\nFixture E: 23 users -> ceil(23/10) = 3 Aura macros");
  const p = new ResponsibilityMacroProcessor();
  const accountIds = Array.from({ length: 23 }, (_, i) => `acc${i + 1}`);
  const replacement = p.buildAuraReplacement(accountIds);
  const auraOpen = (replacement.match(/<ac:structured-macro ac:name="aura-user-profile"/g) || []).length;
  assertEq(auraOpen, 3, "E.1 emits 3 Aura macros");
  assertContains(replacement, 'acc1,acc2,acc3,acc4,acc5,acc6,acc7,acc8,acc9,acc10', "E.2 chunk 1 has 10 users");
  assertContains(replacement, 'acc21,acc22,acc23', "E.3 chunk 3 has remaining 3 users");
})();

// ─── Fixture F: multiple source macros on one page rewrite back-to-front ───
(() => {
  console.log("\nFixture F: two source macros on one page, back-to-front splice");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<p>top</p>',
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="f1">',
    '<ac:parameter ac:name="users"><ri:user ri:account-id="A1" /></ac:parameter>',
    '</ac:structured-macro>',
    '<p>middle</p>',
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="f2">',
    '<ac:parameter ac:name="users"><ri:user ri:account-id="B1" /></ac:parameter>',
    '</ac:structured-macro>',
    '<p>bottom</p>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  assertEq(instances.length, 2, "F.1 finds 2 instances");
  const accountIdsByKey = { "mid:f1": ["A1"], "mid:f2": ["B1"] };
  const { newXml, changes } = p.rewriteStorage(xml, instances, accountIdsByKey);
  assertEq(changes.length, 2, "F.2 two changes");
  assertContains(newXml, '<p>top</p>',    "F.3 top preserved");
  assertContains(newXml, '<p>middle</p>', "F.4 middle preserved");
  assertContains(newXml, '<p>bottom</p>', "F.5 bottom preserved");
  assertContains(newXml, 'users">A1</ac:parameter>', "F.6 macro 1 transplanted A1");
  assertContains(newXml, 'users">B1</ac:parameter>', "F.7 macro 2 transplanted B1");
})();

// ─── Fixture G: lossy params reported & dropped ───
(() => {
  console.log("\nFixture G: lossy params (additionalInformation, width) dropped");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="gggg-7777">',
    '<ac:parameter ac:name="users"><ri:user ri:account-id="A1" /></ac:parameter>',
    '<ac:parameter ac:name="additionalInformation">department</ac:parameter>',
    '<ac:parameter ac:name="width">300px</ac:parameter>',
    '</ac:structured-macro>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  const accountIdsByKey = { "mid:gggg-7777": ["A1"] };
  const { newXml, lossyParamDrops } = p.rewriteStorage(xml, instances, accountIdsByKey);
  assertEq(lossyParamDrops.length, 2, "G.1 reports 2 lossy drops");
  const droppedNames = lossyParamDrops.map((d) => d.paramName).sort();
  assertEq(droppedNames[0], "additionalInformation", "G.2 reports additionalInformation");
  assertEq(droppedNames[1], "width",                 "G.3 reports width");
  assertEq(newXml.includes("additionalInformation"), false, "G.4 additionalInformation absent in output");
  assertEq(newXml.includes("300px"), false, "G.5 width value absent in output");
})();

// ─── Fixture H: no resolved accountIds = skip entire macro ───
(() => {
  console.log("\nFixture H: empty accountIds => macro skipped, xml unchanged");
  const p = new ResponsibilityMacroProcessor();
  const xml =
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="hhhh-8888">' +
    '<ac:parameter ac:name="users"><ri:user ri:account-id="A1" /></ac:parameter>' +
    '</ac:structured-macro>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes, skipped } = p.rewriteStorage(xml, instances, {});
  assertEq(newXml, xml, "H.1 xml unchanged");
  assertEq(changes.length, 0, "H.2 zero changes");
  assertEq(skipped.length, 1, "H.3 one skipped");
  assertEq(skipped[0].reason, "no-resolved-accountids", "H.4 skip reason");
})();

// ─── Fixture I: target users param using <ri:user ri:account-id=...> form ───
(() => {
  console.log("\nFixture I: targetUsersUseRiUser=true emits <ri:user> tags");
  const p = new ResponsibilityMacroProcessor({ targetUsersUseRiUser: true });
  const replacement = p.buildAuraReplacement(["X1", "X2"]);
  assertContains(replacement, '<ri:user ri:account-id="X1" />', "I.1 first ri:user");
  assertContains(replacement, '<ri:user ri:account-id="X2" />', "I.2 second ri:user");
  assertEq(replacement.includes("X1,X2"), false, "I.3 no CSV form");
})();

// ─── Fixture J: nested macro skipped if not a top-level source ───
(() => {
  console.log("\nFixture J: nested structured-macro doesn't confuse the walker");
  const p = new ResponsibilityMacroProcessor();
  const xml = [
    '<ac:structured-macro ac:name="expand" ac:macro-id="outer">',
    '<ac:rich-text-body>',
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="inner">',
    '<ac:parameter ac:name="users"><ri:user ri:account-id="X" /></ac:parameter>',
    '</ac:structured-macro>',
    '</ac:rich-text-body>',
    '</ac:structured-macro>',
  ].join("");
  const instances = p.findCandidateMacros(xml);
  assertEq(instances.length, 1, "J.1 inner responsibility found");
  assertEq(instances[0].macroId, "inner", "J.2 correct macroId");
  // Rewriting should preserve the outer expand wrapper
  const { newXml } = p.rewriteStorage(xml, instances, { "mid:inner": ["X"] });
  assertContains(newXml, '<ac:structured-macro ac:name="expand"', "J.3 outer expand preserved");
  assertContains(newXml, '<ac:structured-macro ac:name="aura-user-profile"', "J.4 aura emitted");
})();

// ─── Fixture K: real Aura format — encodes cards[] as base64-JSON params ───
(() => {
  console.log("\nFixture K: rich Aura output mode produces real Cloud format");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  // The Linchpin source macro carries no users, only profile_field_identifier
  const xml =
    '<p>before</p>' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="kkkk-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    '<p>after</p>';
  const instances = p.findCandidateMacros(xml);
  assertEq(instances.length, 1, "K.1 finds responsible-person-macro by default");
  assertEq(instances[0].name, "responsible-person-macro", "K.2 confirmed name");
  assertEq(
    instances[0].params.profile_field_identifier,
    "confluence.position",
    "K.3 captures profile_field_identifier param",
  );
  const accountIdsByKey = { "mid:kkkk-0001": ["5a958f7a68a2e329295090be", "712020:00000000-0000-0000-0000-000000000000"] };
  const { newXml, changes } = p.rewriteStorage(xml, instances, accountIdsByKey);
  assertEq(changes.length, 1, "K.4 one change");
  assertEq(changes[0].info, "Role Title", "K.5 confluence.position -> Role Title");
  assertContains(newXml, '<ac:structured-macro ac:name="aura-user-profile"', "K.6 emits aura macro");
  assertContains(newXml, 'data-layout="default"', "K.7 includes data-layout attribute");
  assertContains(newXml, '<ac:parameter ac:name="summary">', "K.8 includes summary param");
  assertContains(newXml, '<ac:parameter ac:name="params">', "K.9 includes params param");
  assertContains(newXml, '<p>before</p>', "K.10 preserves before");
  assertContains(newXml, '<p>after</p>',  "K.11 preserves after");
  // No CSV "users" param in rich mode
  assertEq(newXml.includes('ac:name="users">'), false, "K.12 no simple-mode users param");

  // Decode the params and validate the JSON shape
  const m = newXml.match(/<ac:parameter ac:name="params">([^<]+)<\/ac:parameter>/);
  assertEq(!!m, true, "K.13 params capturable");
  const decoded = JSON.parse(decodeURIComponent(Buffer.from(m[1], "base64").toString("utf8")));
  assertEq(Array.isArray(decoded.cards), true, "K.14 cards is array");
  assertEq(decoded.cards.length, 2, "K.15 two cards");
  assertEq(decoded.cards[0].user, "5a958f7a68a2e329295090be", "K.16 card1 user");
  assertEq(decoded.cards[0].info, "Role Title", "K.17 card1 info");
  assertEq(decoded.cards[0].imageType, "default", "K.18 card1 imageType default");
  assertEq(decoded.cards[1].user, "712020:00000000-0000-0000-0000-000000000000", "K.19 card2 user");
  assertEq(decoded.cardSize, "small", "K.20 cardSize default");
  assertEq(decoded.cardStyle, "diagonal", "K.21 cardStyle default");
  assertEq(decoded.shapeColor.light, "#ffffff", "K.22 shapeColor.light default");
})();

// ─── Fixture L: rich mode falls back to default info label for unknown field ───
(() => {
  console.log("\nFixture L: unknown profile_field_identifier -> defaultInfoLabel");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich", defaultInfoLabel: "Profile" });
  const xml =
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="llll-0002">' +
    '<ac:parameter ac:name="profile_field_identifier">some.unknown.key</ac:parameter>' +
    '</ac:structured-macro>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:llll-0002": ["A1"] });
  assertEq(changes[0].info, "Profile", "L.1 falls back to defaultInfoLabel");
  const m = newXml.match(/<ac:parameter ac:name="params">([^<]+)<\/ac:parameter>/);
  const decoded = JSON.parse(decodeURIComponent(Buffer.from(m[1], "base64").toString("utf8")));
  assertEq(decoded.cards[0].info, "Profile", "L.2 cards[0].info uses fallback");
})();

// ─── Fixture M: rich mode emits ONE macro even for many users (no chunking) ───
(() => {
  console.log("\nFixture M: rich mode does not chunk — many users fit in one cards[]");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="mmmm-0003">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>';
  const instances = p.findCandidateMacros(xml);
  const manyIds = Array.from({ length: 23 }, (_, i) => `acc${i + 1}`);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:mmmm-0003": manyIds });
  assertEq(changes[0].chunks, 1, "M.1 single Aura macro (chunks=1)");
  const auraOpen = (newXml.match(/<ac:structured-macro ac:name="aura-user-profile"/g) || []).length;
  assertEq(auraOpen, 1, "M.2 exactly one aura macro emitted");
  const m = newXml.match(/<ac:parameter ac:name="params">([^<]+)<\/ac:parameter>/);
  const decoded = JSON.parse(decodeURIComponent(Buffer.from(m[1], "base64").toString("utf8")));
  assertEq(decoded.cards.length, 23, "M.3 cards[] has all 23 users");
})();

// ─── Fixture N: solo-paragraph wrapper is swallowed (editor-compat fix) ───
(() => {
  console.log("\nFixture N: <p>solo-macro</p> wrapper is swallowed, replaced with <p />");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<ac:layout-cell>' +
    '<h3>GF Responsible</h3>' +
    '<p>' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="nnnn-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    '</p>' +
    '</ac:layout-cell>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:nnnn-0001": ["X1"] });
  assertEq(changes.length, 1, "N.1 one change");
  assertEq(changes[0].paragraphSwallowed, true, "N.2 paragraphSwallowed flag set");
  // No <p>...</p> around the new macro; instead a <p /> placeholder before it
  assertContains(newXml, "<h3>GF Responsible</h3><p /><ac:structured-macro ac:name=\"aura-user-profile\"", "N.3 emits <p /> placeholder before aura macro");
  assertEq(newXml.includes("<p><ac:structured-macro ac:name=\"aura-user-profile\""), false, "N.4 no <p> wrapper around new macro");
  assertEq(newXml.includes("</ac:structured-macro></p>"), false, "N.5 no </p> after new macro");
  assertContains(newXml, "</ac:layout-cell>", "N.6 layout-cell preserved");
})();

// ─── Fixture O: <p>with-other-content + macro</p> is NOT swallowed ───
(() => {
  console.log("\nFixture O: paragraph with siblings is NOT swallowed");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  // Macro is inside a <p> but the <p> also has text — must NOT swallow
  const xml =
    '<p>Some text before ' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="oooo-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    ' some text after</p>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:oooo-0001": ["X1"] });
  assertEq(changes[0].paragraphSwallowed, false, "O.1 paragraphSwallowed flag NOT set");
  assertContains(newXml, "Some text before ", "O.2 leading text preserved");
  assertContains(newXml, " some text after</p>", "O.3 trailing text + </p> preserved");
})();

// ─── Fixture P: macro inside <h2> is NOT swallowed (only <p> is swallowed) ───
(() => {
  console.log("\nFixture P: macro inside <h2> is NOT swallowed");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<h2>SAMPLE MT: ' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="pppp-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    '</h2>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:pppp-0001": ["X1"] });
  assertEq(changes[0].paragraphSwallowed, false, "P.1 paragraphSwallowed flag NOT set for h2");
  assertContains(newXml, "<h2>SAMPLE MT: ", "P.2 h2 wrapper preserved");
  assertContains(newXml, "</h2>", "P.3 </h2> preserved");
})();

// ─── Fixture Q: mixed-paragraph wrap splits before/after the macro ───
(() => {
  console.log("\nFixture Q: <p>text<br/>macro<br/>other</p> splits into 2 paragraphs around macro");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<p>For any questions:<br />' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="qqqq-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    '<br />trailing text</p>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:qqqq-0001": ["X1"] });
  assertEq(changes[0].paragraphSplit, true, "Q.1 paragraphSplit flag set");
  assertEq(changes[0].paragraphSwallowed, false, "Q.2 NOT swallowed (was mixed)");
  assertContains(newXml, "<p>For any questions:<br /></p>", "Q.3 before-content in own paragraph");
  assertContains(newXml, "<p><br />trailing text</p>", "Q.4 after-content in own paragraph");
  assertContains(newXml, '<ac:structured-macro ac:name="aura-user-profile"', "Q.5 aura macro emitted");
  assertEq(newXml.includes("<p>For any questions:<br /><ac:structured-macro ac:name=\"aura-user-profile\""), false, "Q.6 macro NOT inside the original <p>");
})();

// ─── Fixture R: mixed wrap with only BEFORE content ───
(() => {
  console.log("\nFixture R: <p>text macro</p> emits <p>text</p> + macro (no trailing)");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<p>Some lead-in: ' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="rrrr-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro></p>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:rrrr-0001": ["X1"] });
  assertEq(changes[0].paragraphSplit, true, "R.1 paragraphSplit set");
  assertContains(newXml, "<p>Some lead-in: </p>", "R.2 before-content in own paragraph");
  assertEq(newXml.includes("</p><p>") || newXml.includes("</p><ac:"), true, "R.3 paragraph closes before macro");
  // no trailing <p>...</p> after the macro (since after was empty)
  assertEq(/<\/ac:structured-macro><p>/.test(newXml), false, "R.4 no trailing paragraph after macro");
})();

// ─── Fixture S: mixed wrap with only AFTER content ───
(() => {
  console.log("\nFixture S: <p>macro text</p> emits placeholder + macro + <p>text</p>");
  const p = new ResponsibilityMacroProcessor({ auraOutputMode: "rich" });
  const xml =
    '<p>' +
    '<ac:structured-macro ac:name="responsible-person-macro" ac:macro-id="ssss-0001">' +
    '<ac:parameter ac:name="profile_field_identifier">confluence.position</ac:parameter>' +
    '</ac:structured-macro>' +
    ' trailing text</p>';
  const instances = p.findCandidateMacros(xml);
  const { newXml, changes } = p.rewriteStorage(xml, instances, { "mid:ssss-0001": ["X1"] });
  assertEq(changes[0].paragraphSplit, true, "S.1 paragraphSplit set");
  assertContains(newXml, "<p />", "S.2 anchor <p /> placeholder before macro");
  assertContains(newXml, "<p> trailing text</p>", "S.3 trailing-content in own paragraph");
})();

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed === 0 ? 0 : 1);
