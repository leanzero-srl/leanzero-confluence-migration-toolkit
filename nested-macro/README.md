# Nested-Macro Un-nester (Confluence Cloud)

Scans a Confluence Cloud space (or the whole site) for pages containing **nested bodied macros** and rewrites them so the previously-nested macros become siblings. Confluence Cloud's Fabric editor does not support nested bodied macros — pages affected by this render incorrectly and the editor errors with `confluenceADFMigrationUnsupportedContentInternalExtension`.

## How it works

1. **Discovery (Plan phase)** — CQL search for pages with a candidate bodied macro (`info`, `expand`, `panel`, `note`, `warning`, `tip`, `panel`, `details`, `excerpt`, `column`, `section`, `layout`, `status`). For each match, the v2 API storage format is fetched and parsed; every structured-macro whose ancestor chain contains another bodied macro is recorded. The result is a JSON plan under `logs/plan_<ts>.json`.

2. **Un-nest (Execute phase)** — for every pending page, the storage format is re-fetched (to get the current version), parsed, un-nested using the **split-around-child** strategy, serialised, and PUT back via the v2 API.

### Split-around-child

For each outer macro `A` whose body contains an inner macro `B` (directly or transitively):

```
Before:  A[ prefix  B  suffix ]
After:   A[prefix]  +  B  +  A'[suffix]
```

`A'` is a clone of `A`'s wrapper (same `ac:name`, same parameters) with a fresh `ac:macro-id`. Empty halves are dropped. Intermediate tags (`<p>`, `<td>`, layout-cells, etc.) between A's body and B are split too. Runs iteratively until the tree is stable — handles arbitrary nesting depth and multiple sibling inner macros.

### Excluded containers

`column`, `section`, `layout`, `details`, `tabs-group`, `tabs` cannot be split without breaking their structural semantics. For these outer macros, the `--fallback-strategy` flag decides:

- **`skip`** (default) — leave the excluded-container nesting alone; log as `excluded`
- **`promote`** — unwrap the excluded parent (inline its body contents), freeing the inner macro
- **`fail`** — mark the page `unfixable`, do not write

In all strategies, inner non-excluded macros deeper in the tree are still un-nested normally.

## Setup

```bash
cd confluence/nested-macro
cp .env.example .env   # edit with your Cloud credentials
npm install
```

`.env`:
```
CLOUD_BASE_URL=https://your-site.atlassian.net/wiki
CLOUD_EMAIL=you@example.com
CLOUD_API_TOKEN=...
```

## Tests

```bash
npm test
```

Runs:
- **Phase-0 POC** (`test/test_round_trip.js`) — verifies fast-xml-parser can round-trip Confluence storage XML (namespaces, CDATA, entities, layouts).
- **Unit tests** (`test/test_unnest.js`) — 19 tests across detector + split-around-child, including 2-deep, 3-deep, multi-sibling, idempotence, macro-id refresh, excluded containers, CDATA false-positives.

## Usage

```bash
# Build plan only — no writes
node main/sync_nested_macros.js --plan-only --space PROJ

# Dry-run a single space with a limit
node main/sync_nested_macros.js --dry-run --space PROJ --limit 10

# Full run on one space
node main/sync_nested_macros.js --space PROJ

# Resume a partially-executed plan
node main/sync_nested_macros.js --execute-only --plan-file ./logs/plan_1712345678901.json

# Scan every space, promoting excluded-container parents
node main/sync_nested_macros.js --all --fallback-strategy promote
```

### CLI options

| Flag | Purpose |
|---|---|
| `--space <KEY>` | Space key — repeatable or comma-separated |
| `--all` | Scan every space |
| `--limit <N>` | Cap pages processed |
| `--plan-only` | Build plan, do not execute |
| `--execute-only`, `--resume` | Load existing plan and execute |
| `--plan-file <path>` | Path to plan JSON (default: latest in `logs/`) |
| `--retry-failed` | Reprocess plan entries with status `failed` |
| `--concurrency <N>` | Parallel PUT workers (default: 3) |
| `--dry-run` | Simulate — no writes |
| `--candidate-macros <list>` | Override CQL candidate macro list |
| `--excluded-containers <list>` | Override non-splittable container list |
| `--fallback-strategy <mode>` | `skip` (default) / `promote` / `fail` |
| `--help` | Show help |

## Plan JSON shape

```json
{
  "version": "1.0",
  "runId": "1712345678901",
  "createdAt": "2026-04-24T...",
  "stats": { "total": N, "pending": N, "completed": N, "failed": N, "skipped": N, "unfixable": N },
  "totals": { "nestedFound": N, "fixable": N, "excluded": N, "unfixable": N },
  "pages": {
    "<pageId>": {
      "status": "pending|completed|failed|skipped|unfixable",
      "pageId": "...",
      "spaceKey": "...",
      "title": "...",
      "version": N,
      "nestings": [
        { "outerMacro": "info", "innerMacro": "panel", "depth": 2, "path": "info > panel", "strategy": "split" }
      ],
      "beforeHash": "sha1",
      "afterHash": "sha1",
      "error": null,
      "updatedAt": "..."
    }
  }
}
```

## Safety notes

- **v2 API storage round-trip** is the write path. Phase-0 POC passed against a battery of fixtures (namespaces, CDATA, entities, layouts, mixed content) — verified before the algorithm was built.
- **Dry-run first**. Always. The plan+execute split lets you inspect `plan_*.json` before any PUT.
- Version conflicts (409) auto-retry once after re-fetch.
- 429 rate limits honour `Retry-After` with exponential backoff (3 attempts, up to 60s).
- `beforeHash` / `afterHash` in the plan let you audit every change.
- SIGINT/SIGTERM persist the in-flight plan before exit.

## Known limitations

- **Forge-wrapped bodied extensions** (`bodiedExtension` in ADF with `extensionType=com.atlassian.ecosystem`) are not handled by this v1 — storage-format scope only. Add `--include-forge` + ADF support in a future revision if required.
- Splitting a numbered-list parent resets list numbering in each split half. Acceptable trade for unblocking Cloud rendering.
- `--fallback-strategy=skip` leaves excluded-container nestings in place; they'll continue to fail in Cloud. Use `promote` to force resolution at the cost of layout flattening.

## Related scripts in this repo

- `confluence/html-macro/` — re-injects broken HTML/CSS macro bodies post-migration. Pattern source for the Cloud client and plan manager.
- `confluence/visibility-macro/` — migrates Show-If / Hide-If macros from DC names to Cloud IDs. Pattern source for CQL search pagination.
