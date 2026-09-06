const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const crypto = require("crypto");

// fast-xml-parser (v4) `preserveOrder` tree shape:
//   A node is an object with EXACTLY ONE non-":@" key — the tag name.
//   Its value is an array of child nodes (also single-key objects).
//   Attributes sit on a sibling key ":@" whose value is an object of
//   attribute entries prefixed with "@_".
//   Text: {"#text": "..."}.
//   CDATA: {"__cdata": [{"#text": "..."}]}.
//
// We keep `processEntities: false` so &nbsp;, &ndash; etc. survive the
// round-trip untouched — Confluence storage isn't strict XML about
// entity declarations, so asking the parser to resolve them breaks.

const SPECIAL_KEYS = new Set(["#text", "__cdata", ":@"]);

function makeParser() {
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    cdataPropName: "__cdata",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
    htmlEntities: true,
  });
}

function makeBuilder() {
  return new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    cdataPropName: "__cdata",
    format: false,
    processEntities: false,
    suppressEmptyNode: false,
  });
}

const ROOT_OPEN = "<__sf_root__>";
const ROOT_CLOSE = "</__sf_root__>";

/**
 * Parse a Confluence storage-format fragment.
 * Returns an array of top-level nodes (preserveOrder shape).
 */
function parse(storageXml) {
  const parser = makeParser();
  const wrapped = ROOT_OPEN + storageXml + ROOT_CLOSE;
  const tree = parser.parse(wrapped);
  const root = tree.find((n) => getTag(n) === "__sf_root__");
  if (!root) return [];
  return root["__sf_root__"] || [];
}

/**
 * Serialize an array of preserveOrder nodes back to storage-format XML.
 */
function serialize(nodes) {
  const builder = makeBuilder();
  const out = builder.build([{ __sf_root__: nodes }]);
  // Strip our synthetic root wrapper.
  if (out.startsWith(ROOT_OPEN) && out.endsWith(ROOT_CLOSE)) {
    return out.slice(ROOT_OPEN.length, out.length - ROOT_CLOSE.length);
  }
  // Tolerate self-closed wrapper when empty.
  if (out === "<__sf_root__/>" || out === "<__sf_root__></__sf_root__>") {
    return "";
  }
  return out;
}

/** Get the tag name of a preserveOrder node (or null for text/cdata). */
function getTag(node) {
  if (!node || typeof node !== "object") return null;
  for (const key of Object.keys(node)) {
    if (!SPECIAL_KEYS.has(key)) return key;
  }
  return null;
}

/** Is the node pure text (no tag, just "#text")? */
function isText(node) {
  return node && typeof node === "object" && "#text" in node && getTag(node) === null;
}

/** Get child array for a tagged node. */
function getChildren(node) {
  const tag = getTag(node);
  if (!tag) return null;
  return node[tag];
}

/** Attribute accessor — returns string value or undefined. */
function getAttr(node, attrName) {
  if (!node || !node[":@"]) return undefined;
  return node[":@"]["@_" + attrName];
}

function setAttr(node, attrName, value) {
  if (!node[":@"]) node[":@"] = {};
  node[":@"]["@_" + attrName] = value;
}

/**
 * Find the first direct child of a structured-macro element with the given
 * tag. Returns { node, index } or null.
 */
function findChildByTag(parent, tag) {
  const children = getChildren(parent);
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    if (getTag(children[i]) === tag) return { node: children[i], index: i };
  }
  return null;
}

/** Deep-clone a preserveOrder subtree. JSON round-trip is sufficient —
 *  the tree contains only plain objects, arrays, and strings. */
function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

/** Generate a UUID-ish id matching the shape Confluence uses for macro-id
 *  (random hex with dashes). */
function newMacroId() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Semantic hash of a storage-format fragment: parse + serialize + sha1.
 * Same input under the same parser produces the same hash regardless of
 * whitespace quirks introduced by the round-trip itself.
 */
function semanticHash(storageXml) {
  const tree = parse(storageXml);
  const normalised = serialize(tree);
  return crypto.createHash("sha1").update(normalised).digest("hex");
}

/**
 * Check whether a node is a macro element (regardless of its ac:name).
 *
 * Confluence has two equivalent storage-format tags for macros:
 *   - `ac:structured-macro` — modern form (current Confluence)
 *   - `ac:macro`            — legacy form (pre-5.0 / un-migrated content)
 *
 * The Atlassian developer community confirms these are interchangeable;
 * the server auto-promotes legacy `ac:macro` → `ac:structured-macro` on
 * the next write. We match both so detection works on mixed content.
 */
function isStructuredMacro(node) {
  const t = getTag(node);
  return t === "ac:structured-macro" || t === "ac:macro";
}

/** Get the macro name (ac:name attribute) of a structured-macro node. */
function getMacroName(macroNode) {
  return getAttr(macroNode, "ac:name");
}

/**
 * Depth-first search for the first descendant structured-macro within a
 * children array (used for detection). Returns true if found.
 */
function hasDescendantStructuredMacro(children) {
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (isStructuredMacro(child)) return true;
    const nested = getChildren(child);
    if (Array.isArray(nested) && hasDescendantStructuredMacro(nested)) return true;
  }
  return false;
}

module.exports = {
  parse,
  serialize,
  getTag,
  isText,
  getChildren,
  getAttr,
  setAttr,
  findChildByTag,
  cloneNode,
  newMacroId,
  semanticHash,
  isStructuredMacro,
  getMacroName,
  hasDescendantStructuredMacro,
};
