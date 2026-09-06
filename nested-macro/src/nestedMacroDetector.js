const sfp = require("./storageFormatParser");

/**
 * Detect nested bodied macros in a parsed storage-format tree.
 *
 * A "nesting" is any structured-macro whose ancestor chain (within its
 * containing storage fragment) includes another structured-macro whose
 * body is <ac:rich-text-body> (not plain-text-body / CDATA).
 *
 * Returns an array of finding objects:
 *   { outerMacro, innerMacro, depth, path }
 *
 * where depth counts structured-macro ancestors (2 = direct nesting,
 * 3 = nested two deep, etc.), and path is a human-readable trail of
 * macro names (e.g. "expand > info > note").
 *
 * Note: <ac:plain-text-body> holds CDATA whose content is NOT parsed as
 * XML, so any literal "<ac:structured-macro>" text inside CDATA is
 * ignored. This is enforced by the parser + by this walker only
 * recursing into rich-text-body.
 */
function detect(tree) {
  const findings = [];
  walk(tree, [], findings);
  return findings;
}

function walk(nodes, ancestorMacros, findings) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (sfp.isStructuredMacro(node)) {
      const macroName = sfp.getMacroName(node) || "(unknown)";

      if (ancestorMacros.length > 0) {
        const outer = ancestorMacros[ancestorMacros.length - 1];
        findings.push({
          outerMacro: outer,
          innerMacro: macroName,
          depth: ancestorMacros.length + 1,
          path: [...ancestorMacros, macroName].join(" > "),
        });
      }

      // Only rich-text-body contains parsed markup; plain-text-body is CDATA.
      const body = sfp.findChildByTag(node, "ac:rich-text-body");
      if (body) {
        walk(
          sfp.getChildren(body.node),
          [...ancestorMacros, macroName],
          findings,
        );
      }
    } else {
      // Any other element — recurse into children; macros can be buried
      // inside <p>, <div>, <td>, layout-cells, etc.
      const children = sfp.getChildren(node);
      if (Array.isArray(children)) walk(children, ancestorMacros, findings);
    }
  }
}

module.exports = { detect };
