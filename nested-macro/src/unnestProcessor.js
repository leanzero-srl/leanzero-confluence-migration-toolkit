const sfp = require("./storageFormatParser");

/**
 * Un-nest bodied macros using the split-around-child strategy.
 *
 * For each structured-macro `A` whose <ac:rich-text-body> (directly or
 * transitively) contains another structured-macro `T`, rewrite the tree so
 * that:
 *
 *   A[ prefix … T … suffix ]   →   A[prefix]  +  T  +  A'[suffix]
 *
 * where A' is a shallow clone of A's wrapper (same ac:name, same
 * <ac:parameter> children) with a fresh ac:macro-id and different body
 * contents. Intermediate tags (<p>, <td>, layout-cells, etc.) between A's
 * body and T are likewise split — any ancestor of T *within* A is cloned
 * into the before- and after- halves.
 *
 * The `before` and `after` halves are dropped if they have no substance
 * (empty or whitespace-only).
 *
 * A single pass handles one target per macro. The driver re-runs passes
 * until the tree is stable, handling N-deep nesting and multi-sibling
 * inner macros.
 *
 * Excluded containers (layouts, columns, details, tabs) cannot be split
 * without breaking layout. For those the `fallbackStrategy` decides:
 *   - "skip":    leave the nesting in place, count as excluded
 *   - "promote": unwrap the excluded parent (inline its body contents),
 *                leaving the inner macro free-standing
 *   - "fail":    mark the page unfixable so the caller does nothing
 */

// Structural macros — splitting them around a child, or extracting them
// from their parent, breaks the visual/layout contract. Real-world
// Confluence Cloud tenants also have third-party / legacy app content
// using `ac:structured-macro ac:name="table|tr|td|div"` as wrappers;
// those are included too. `show-if`/`hide-if` are owned by the visibility
// macro migration script and should be left alone here.
const DEFAULT_EXCLUDED = new Set([
  "column",
  "section",
  "layout",
  "details",
  "tabs-group",
  "tabs",
  "table",
  "tr",
  "td",
  "div",
  "show-if",
  "hide-if",
]);

// Even with the land-on-after optimisation, pathological pages (deep AND
// wide) may need many passes. 500 is plenty of headroom for real content;
// anything beyond that is probably an infinite loop worth aborting.
const DEFAULT_MAX_PASSES = 500;

function unnest(tree, opts = {}) {
  const excludedContainers = opts.excludedContainers || DEFAULT_EXCLUDED;
  const fallbackStrategy = opts.fallbackStrategy || "skip";
  const maxPasses = opts.maxPasses || DEFAULT_MAX_PASSES;
  const onChange = opts.onChange || (() => {});

  const stats = { changes: 0, excludedHits: 0, unfixable: 0, passes: 0, promoted: 0 };
  let unfixableFlag = false;

  for (let p = 0; p < maxPasses; p++) {
    stats.passes++;
    const passResult = runPass(tree, {
      excludedContainers,
      fallbackStrategy,
      onChange,
      onUnfixable: () => { unfixableFlag = true; },
    });
    stats.changes += passResult.changes;
    stats.excludedHits += passResult.excludedHits;
    stats.unfixable += passResult.unfixable;
    stats.promoted += passResult.promoted;

    if (!passResult.changed) return { stats, unfixable: unfixableFlag };
  }
  throw new Error(`Un-nest did not converge in ${maxPasses} passes`);
}

/**
 * Run a single pass over a node array. Mutates `nodes` in place via splice.
 * Returns { changed, changes, excludedHits, unfixable, promoted }.
 */
function runPass(nodes, opts) {
  let changed = false;
  let changes = 0;
  let excludedHits = 0;
  let unfixable = 0;
  let promoted = 0;

  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];

    if (sfp.isStructuredMacro(node)) {
      const outerName = sfp.getMacroName(node);
      const body = sfp.findChildByTag(node, "ac:rich-text-body");

      if (body) {
        const target = findFirstStructuredMacroDescendant(body.node);

        if (target) {
          const innerName = sfp.getMacroName(target);
          const outerExcluded = opts.excludedContainers.has(outerName);
          const innerExcluded = opts.excludedContainers.has(innerName);
          if (outerExcluded || innerExcluded) {
            // Either side being structural means split-around-child would
            // damage layout. The fallback strategy decides what to do;
            // "promote" only makes sense when the OUTER is excluded.
            excludedHits++;
            if (outerExcluded) {
              const handled = handleExcluded(nodes, i, node, opts);
              if (handled.action === "promote") {
                changes++;
                promoted++;
                changed = true;
                opts.onChange({ outer: outerName, inner: innerName, action: "promote" });
                i += handled.advance;
                continue;
              }
              if (handled.action === "unfixable") {
                unfixable++;
                opts.onUnfixable();
              }
            } else {
              // Outer is OK but inner is layout — leave it alone (split
              // would extract the layout child, destroying layout).
              if (opts.fallbackStrategy === "fail") {
                unfixable++;
                opts.onUnfixable();
              }
            }
            // "skip" (and default inner-excluded) falls through.
          } else {
            // Split the BODY's children around target, then rebuild the outer
            // macro twice — once with each body half. All non-body siblings
            // (most importantly <ac:parameter>) are preserved on BOTH halves
            // by cloneMacroWithBody; otherwise the AFTER clone would silently
            // lose the macro's title/colour/etc. configuration.
            const bodySplit = splitAroundDescendant(body.node, target);
            if (bodySplit.found) {
              const beforeMacro = cloneMacroWithBody(node, bodySplit.before);
              const afterMacro = cloneMacroWithBody(node, bodySplit.after);
              const replacement = [];
              if (hasSubstance(beforeMacro)) {
                refreshMacroId(beforeMacro);
                replacement.push(beforeMacro);
              }
              replacement.push(target);
              if (hasSubstance(afterMacro)) {
                refreshMacroId(afterMacro);
                replacement.push(afterMacro);
              }
              nodes.splice(i, 1, ...replacement);
              changes++;
              changed = true;
              opts.onChange({ outer: outerName, inner: sfp.getMacroName(target), action: "split" });
              // Land on the LAST inserted element so the next iteration can
              // keep un-nesting inside it. For a typical [before, target, after]
              // replacement, this means landing on `after` — which may still
              // contain sibling nested macros, and a pass should handle them
              // all rather than needing one pass per split.
              i += Math.max(0, replacement.length - 1);
              continue;
            }
          }
        }
      }
    }

    // Recurse into children that could contain macros.
    const children = sfp.getChildren(node);
    if (Array.isArray(children)) {
      const sub = runPass(children, opts);
      changes += sub.changes;
      excludedHits += sub.excludedHits;
      unfixable += sub.unfixable;
      promoted += sub.promoted;
      if (sub.changed) changed = true;
    }
    i++;
  }

  return { changed, changes, excludedHits, unfixable, promoted };
}

/**
 * Find the first structured-macro descendant inside an ac:rich-text-body
 * node (or other container). Depth-first search, returns the node itself.
 */
function findFirstStructuredMacroDescendant(containerNode) {
  const children = sfp.getChildren(containerNode);
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    if (sfp.isStructuredMacro(child)) return child;
    const nested = findFirstStructuredMacroDescendant(child);
    if (nested) return nested;
  }
  return null;
}

/**
 * Structural split of `containerNode` around `target` (a descendant).
 *
 * Returns { found, before, after }:
 *   before — shallow-cloned copy of containerNode with children up to
 *            (excluding) target. Ancestors of target within containerNode
 *            are likewise shallow-cloned with truncated children.
 *   after  — shallow-cloned copy of containerNode with children starting
 *            from (excluding) target.
 *
 * Deep subtrees that don't contain target are shared by reference — no
 * mutation is done to them. Only the path from containerNode down to
 * target is cloned.
 */
function splitAroundDescendant(containerNode, target) {
  const children = sfp.getChildren(containerNode);
  if (!Array.isArray(children)) return { found: false };

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === target) {
      const before = cloneWithChildren(containerNode, children.slice(0, i));
      const after = cloneWithChildren(containerNode, children.slice(i + 1));
      return { found: true, before, after };
    }
    const nested = splitAroundDescendant(child, target);
    if (nested.found) {
      const before = cloneWithChildren(
        containerNode,
        [...children.slice(0, i), nested.before],
      );
      const after = cloneWithChildren(
        containerNode,
        [nested.after, ...children.slice(i + 1)],
      );
      return { found: true, before, after };
    }
  }
  return { found: false };
}

/** Build a new node with the same tag + attributes as `src`, but with
 *  the given children array. Attributes are shallow-cloned. */
function cloneWithChildren(src, newChildren) {
  const tag = sfp.getTag(src);
  const out = {};
  if (src[":@"]) {
    out[":@"] = { ...src[":@"] };
  }
  out[tag] = newChildren;
  return out;
}

/**
 * Clone a structured-macro `macroNode` with its <ac:rich-text-body> replaced
 * by `newBodyNode`. All other children — most importantly the macro's
 * <ac:parameter> siblings — are preserved at their original positions and
 * shared by reference. The un-nest algorithm never mutates parameter
 * subtrees so reference-sharing is safe; serialization sees them once per
 * clone in the output XML.
 */
function cloneMacroWithBody(macroNode, newBodyNode) {
  const tag = sfp.getTag(macroNode);
  const out = {};
  if (macroNode[":@"]) out[":@"] = { ...macroNode[":@"] };
  const children = sfp.getChildren(macroNode);
  if (Array.isArray(children)) {
    out[tag] = children.map((child) =>
      sfp.getTag(child) === "ac:rich-text-body" ? newBodyNode : child,
    );
  } else {
    out[tag] = [];
  }
  return out;
}

/** CDATA nodes carry their payload under "__cdata"; getTag() reports null
 *  for them since "__cdata" is a SPECIAL_KEYS entry. Detect them explicitly
 *  so substance checks don't treat a CDATA-only half as empty. */
function isCdataNode(node) {
  return !!node && typeof node === "object" && Array.isArray(node.__cdata);
}

/** Detect whether a split half has anything worth keeping.
 *  We consider it substantial if it contains any non-whitespace text node
 *  or any element node. Empty/whitespace-only halves get dropped. */
function hasSubstance(node) {
  return subtreeHasSubstance(node);
}

function subtreeHasSubstance(node) {
  if (!node || typeof node !== "object") return false;
  // Bare CDATA blocks count as content even though they have no element tag.
  if (isCdataNode(node)) return true;
  const tag = sfp.getTag(node);
  if (tag === null) {
    // Text node
    if (typeof node["#text"] === "string" && node["#text"].trim() !== "") return true;
    return false;
  }
  const children = sfp.getChildren(node);
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (isCdataNode(child)) return true;
    const childTag = sfp.getTag(child);
    if (childTag === null) {
      if (typeof child["#text"] === "string" && child["#text"].trim() !== "") return true;
      continue;
    }
    // Any non-whitespace element child counts. But we don't want empty
    // parameter-only structured-macro clones to count as substance — for
    // a structured-macro the body must have substance.
    if (childTag === "ac:parameter") continue; // parameters alone aren't substance
    if (childTag === "ac:rich-text-body" || childTag === "ac:plain-text-body") {
      if (subtreeHasSubstance(child)) return true;
      continue;
    }
    // Any other element (<p>, <div>, nested macros, images, etc.)
    return true;
  }
  return false;
}

/** Give a cloned structured-macro a fresh ac:macro-id so the two halves
 *  don't share IDs with each other or the original. */
function refreshMacroId(macroNode) {
  if (sfp.isStructuredMacro(macroNode)) {
    sfp.setAttr(macroNode, "ac:macro-id", sfp.newMacroId());
  }
  // For non-macro clones (e.g. paragraphs), nothing to refresh.
}

/**
 * Excluded-container fallback.
 *
 * - "skip":    no-op; structural nesting remains.
 * - "promote": replace the excluded parent with its body contents inline.
 *              This unwraps the layout/column and lets the inner macro
 *              stand alone at the parent's former position.
 * - "fail":    mark page unfixable.
 */
function handleExcluded(nodes, i, parentNode, opts) {
  if (opts.fallbackStrategy === "fail") {
    return { action: "unfixable", advance: 1 };
  }
  if (opts.fallbackStrategy === "promote") {
    const body = sfp.findChildByTag(parentNode, "ac:rich-text-body");
    const bodyChildren = body ? (sfp.getChildren(body.node) || []) : [];
    nodes.splice(i, 1, ...bodyChildren);
    return { action: "promote", advance: bodyChildren.length };
  }
  // Default: skip
  return { action: "skip", advance: 1 };
}

module.exports = {
  unnest,
  DEFAULT_EXCLUDED,
  // exported for testing
  splitAroundDescendant,
  findFirstStructuredMacroDescendant,
  hasSubstance,
};
