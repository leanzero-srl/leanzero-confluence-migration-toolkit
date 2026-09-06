# Composition Tabs Migration Fix

Phase-1 fix for **mis-migrated Appfire Composition Tabs** macros in Confluence Cloud.

## Why

After Atlassian DC → Cloud migration, Composition's _Deck of Cards_ and _Card_ macros sometimes land in Cloud as `<ac:structured-macro ac:name="deck">` and `ac:name="card">`. Those names collide with Confluence Cloud native macros and the pages stop rendering. Appfire's Cloud-compatible legacy equivalents are `tab-group` and `tab`, so the fix is a storage-XHTML rewrite:

- `<ac:structured-macro ac:name="deck">` → `<ac:structured-macro ac:name="tab-group">`
- `<ac:structured-macro ac:name="card">` → `<ac:structured-macro ac:name="tab">`
- top-level card param `<ac:parameter ac:name="label">…</ac:parameter>` → `ac:name="title"`
- (optional, default ON) top-level deck param `id` → `deckId`
- everything else (macro IDs, schema versions, `<ac:rich-text-body>` content, other params) is preserved byte-for-byte.

Phase-2 (legacy Tab Group/Tab → modern _Tabs_ macro) is **not** in scope — Appfire's in-product **Switch to Tabs** converter is the supported path for that.

## What this script does

1. CQL-scans Cloud for pages containing `deck` or `card` macros.
2. For each candidate page, parses the storage XHTML and applies a **default-deny** verification:
   - Every `deck` is treated as Composition (Cloud-native panels never use `ac:name="deck"` in storage).
   - A `card` is rewritten only if it has a `deck`/`tab-group`/`tab` ancestor **or** a Composition-shaped `label` parameter. Stand-alone cards without any Composition signal are skipped with a recorded reason.
3. Splice-rewrites the storage XHTML in place — only the macro `ac:name` attribute and the targeted parameter names change. Everything else is byte-equal to the original.
4. Writes a per-page backup XHTML, unified diff, and metadata JSON to `backups/`.
5. PUTs the page back via the v1 storage representation, preserving the macro IDs.
6. Verifies via CQL that the residual `deck`/`card` count drops to (ambiguous-card-skips + failures).

## Setup

```bash
cd confluence/composition-tabs
cp .env.example .env
# fill in CLOUD_BASE_URL / CLOUD_EMAIL / CLOUD_API_TOKEN
npm install
```

## Usage

```bash
# Dry-run a single space, single page
node main/sync_composition_tabs.js --dry-run --space DOCS --limit 1

# Plan only (no writes)
node main/sync_composition_tabs.js --plan-only --space DOCS

# Execute an existing plan
node main/sync_composition_tabs.js --execute-only --plan-file logs/plan_<runId>.json

# Multiple spaces, higher concurrency
node main/sync_composition_tabs.js --space DOCS,KB,OPS --concurrency 5

# Whole tenant
node main/sync_composition_tabs.js --all
```

### Options

| Flag | Default | Notes |
|---|---|---|
| `--plan-only` | off | Build plan, skip execute |
| `--execute-only` / `--resume` | off | Load plan and execute |
| `--plan-file PATH` | latest in `logs/` | Plan JSON path |
| `--dry-run` | off | Plan + simulate execute (no PUTs); backups still written |
| `--space K[,K…]` | (none) | Required unless `--all` |
| `--all` | off | Scan every space |
| `--limit N` | unlimited | Cap planned pages |
| `--concurrency N` | 3 | Worker pool size |
| `--retry-failed` | off | Re-attempt pages with `status="failed"` |
| `--old-deck-key K` | `deck` | Repeatable; override DC raw key |
| `--old-card-key K` | `card` | Repeatable; override DC raw key |
| `--no-rename-deck-id` | off | Skip the `id`→`deckId` rename on tab-group |
| `--card-label-param NAME` | `label` | Source param name to rename |
| `--card-title-param NAME` | `title` | Target param name on tab |
| `--version-message MSG` | `Composition Tabs migration fix: Deck/Card -> Tab Group/Tab` | PUT version comment |
| `--backup-dir PATH` | `backups/` | Override |
| `--no-backup` | off | NOT recommended |
| `--no-verify-after` | off | Skip the post-run residual-CQL check |
| `--help` / `-h` | — | Print usage |

## Plan file

`logs/plan_<runId>.json` — same envelope as the visibility-macro script. Per-page entry:

```json
{
  "cloudPageId": "17072682",
  "spaceKey": "HR",
  "title": "Benefits - Region Three",
  "contentType": "page",
  "currentVersion": 79,
  "macros": [
    { "macroId": "44b4d34d-…", "oldName": "deck", "newName": "tab-group",
      "paramRenames": [{"from":"id","to":"deckId"}], "ancestor": null,
      "reason": "deck-always" },
    { "macroId": "cfed968e-…", "oldName": "card", "newName": "tab",
      "paramRenames": [{"from":"label","to":"title"}], "ancestor": "deck",
      "reason": "card-composition-ancestor" }
  ],
  "backupPath": "backups/page_17072682_v79.xhtml",
  "diffPath":   "backups/page_17072682_v79.diff.patch",
  "status": "completed",
  "completedVersion": 80
}
```

`completedVersion` is filled with `currentVersion + 1` on success — that's what `restore_composition_tabs.js` uses to compute the previous version for native rollback.

## Backups

Before each PUT, the script writes:

- `backups/page_<id>_v<v>.xhtml` — verbatim original storage value
- `backups/page_<id>_v<v>.diff.patch` — unified diff (informational, never re-applied)
- `backups/page_<id>_v<v>.meta.json` — `{cloudPageId, spaceKey, title, currentVersion, postPutVersion, runId, sha1Before, sha1After}`

Files are append-only; collisions surface reruns on already-touched pages.

## Restore / rollback

Two layers, used in this order:

```bash
# 1. Native version restore (recommended) — atomic, audited.
node main/restore_composition_tabs.js --plan-file logs/plan_<runId>.json --dry-run
node main/restore_composition_tabs.js --plan-file logs/plan_<runId>.json

# 2. Local backup PUT — only if native version history is gone.
node main/restore_composition_tabs.js --plan-file logs/plan_<runId>.json --from-backup
```

The native path calls `POST /wiki/rest/api/content/{id}/version` with `operationKey: "RESTORE"` and `versionNumber = completedVersion - 1`. This creates a new version that's a copy of the historical one, so the page's history shows both the migration and the rollback.

## Edge cases handled

- **Self-closing macros** (`<ac:structured-macro .../>`) — opening-tag splice still rewrites `ac:name`.
- **CDATA inside parameter values** — only the `ac:name` attribute on the param's opening tag is touched; CDATA in the value is well outside that.
- **Multiple decks per page** — back-to-front splice ordering prevents index shift.
- **Decks nested inside panel/info/expand/column** — the walker tracks an ancestor stack, finds the deck regardless of wrapper.
- **Partial prior conversion** — a `card` whose ancestor stack contains `tab-group` is recognized as Composition and converted.
- **Cloud-native cards** (which appear as `<ac:adf-extension>` in storage, not `<ac:structured-macro ac:name="card">`) — never matched by the regex, untouched.
- **Param-rename conflict** (both `label` and `title` already present on a card) — the old block is deleted and the conflict logged.
- **Idempotency** — if the rewrite produces byte-identical XHTML, the page is marked `skipped: no-op` and not PUT.
- **409 conflict** — handled inside `updatePageStorage` (re-fetch + retry once); if the saved spans no longer match the fresh storage, the page is marked `failed: stale-plan-after-conflict`.

## Files

```
confluence/composition-tabs/
├── main/
│   ├── sync_composition_tabs.js          # CLI entry (plan + execute)
│   └── restore_composition_tabs.js       # rollback (native or --from-backup)
├── src/
│   ├── cloudConfluenceClient.js          # https-based Cloud REST client
│   ├── planManager.js                    # plan_<runId>.json read/write
│   └── compositionMacroProcessor.js      # splice-rewrite engine
├── test/
│   ├── fixtures/                         # *.before.xhtml + *.after.xhtml pairs
│   └── test{1..6}_*.js                   # offline + online tests
├── logs/                                 # plan files + run logs
└── backups/                              # per-page original XHTML + diffs
```

## Testing

```bash
# Offline fixture tests (no network)
node test/test3_rewrite_fixture_pairs.js

# Online: CQL discovery on a space
node test/test1_cql_find.js DOCS

# Online: print the macro instances on one page
node test/test2_extract_macros_single_page.js <pageId>

# Online: dry-run on one page
node test/test4_dry_run_single_page.js <pageId>

# Online: execute on one page
node test/test5_execute_single_page.js <pageId>

# Online: post-run residual count
node test/test6_residual_zero_after_run.js DOCS
```
