# Sync Visibility Macros: DC names -> Cloud IDs

After migrating from Confluence DC to Cloud, the Visibility for Confluence
"Show If" / "Hide If" macros stop showing protected content because their
`users` and `user-groups` parameters reference DC usernames and DC group
names. The Cloud version of the app expects Atlassian `accountId` and
`groupId`. This script:

1. Scans Cloud (CQL) for pages containing `show-if` / `hide-if` macros.
2. Looks up the matching DC page (by space + title) for ground-truth params.
3. Resolves DC user / group names to Cloud `accountId` / `groupId`.
4. Rewrites the macro parameters in the Cloud page body and PUTs the update.

## Setup

```bash
cd confluence/visibility-macro
cp .env.example .env
# fill DC_*, CLOUD_* values
npm install
```

## Usage

```bash
# Dry-run a single page (the DOCS sandbox example)
node main/sync_visibility_macros.js --dry-run --space DOCS --limit 1

# Plan only, single space
node main/sync_visibility_macros.js --plan-only --space DOCS

# Execute an existing plan
node main/sync_visibility_macros.js --execute-only --plan-file logs/plan_<id>.json

# Multiple spaces, higher concurrency
node main/sync_visibility_macros.js --space DOCS,DOCS,OPS --concurrency 5

# Scan everything (after you trust it on smaller scopes)
node main/sync_visibility_macros.js --all
```

### Options

| Option | Default | Notes |
|---|---|---|
| `--dry-run` | off | Plan + simulate execute, no writes |
| `--space KEY[,KEY...]` | (none) | Required unless `--all` |
| `--all` | off | Scan every space |
| `--limit N` | unlimited | Cap on planned pages |
| `--plan-only` | off | Build plan, skip execute |
| `--execute-only` / `--resume` | off | Load existing plan and execute |
| `--plan-file <path>` | latest | Path to plan JSON |
| `--concurrency N` | 3 | Parallel page workers |
| `--retry-failed` | off | Reprocess failed entries |
| `--macro-name <list>` | `show-if,hide-if` | Macro `ac:name`s to handle |
| `--cloud-groups-param-name <n>` | `groups` | Parameter name to use when writing groups; some tenants use `user-groups` |
| `--user-mapping <csv>` | (none) | DC `username,accountId` — overrides API lookup |
| `--group-mapping <csv>` | (none) | DC `groupName,groupId` — overrides API lookup |
| `--strict-dc` | off | Force Cloud to mirror DC exactly when the DC page+macro are matched. Empty DC groups/users will CLEAR them in Cloud (use to revert a prior `--default-groups` run). Pages where DC cannot be matched are still left alone. Disables `--default-groups`. |

### Identity resolution

- **Groups:** `GET /wiki/rest/api/group/by-name?name=<name>`
- **Users:** CQL `type=user AND user.fullname~"<name>"` (takes the exact match;
  warns on ambiguity). For best fidelity, supply a `--user-mapping` CSV
  exported from the Atlassian Cloud Migration Assistant.

Both lookups are cached in `logs/group_id_cache.json` and
`logs/user_id_cache.json` across runs (negative results too).

### Plan file shape

`logs/plan_<runId>.json` keyed by Cloud page ID, with each macro carrying
both the original DC params, the (possibly empty) current Cloud params, the
resolved IDs, and any unresolved names that were skipped.

## Verification on the sandbox example

Test pages used during development:

- Cloud: `https://your-sandbox.atlassian.net/wiki/spaces/DOCS/pages/123456789/Full+Cash+Out+WIP`
- DC source: contains groups `staff, wiki_external`

Run the test scripts (each is a focused integration test against the
configured tenants):

```bash
node test/test1_cql_find_visibility_macros.js DOCS
node test/test2_extract_params_single_page.js 123456789
node test/test3_resolve_users_groups.js --groups "staff,wiki_external"
node test/test4_dry_run_single_page.js 123456789 DOCS
```

Then run the real update on just that page:

```bash
node main/sync_visibility_macros.js --space DOCS --limit 1
```

## Files

- `main/sync_visibility_macros.js` — CLI entry point
- `src/cloudConfluenceClient.js` — Cloud REST client (CQL search, page
  get/update, group/user lookup)
- `src/datacenterConfluenceClient.js` — DC REST client (CQL search, page
  fetch) — same module as `confluence/html-macro/`
- `src/visibilityMacroProcessor.js` — depth-aware macro parser, plan
  builder, executor
- `src/identityResolver.js` — name → id resolver with persistent caches
  and CSV mapping fallback
- `src/planManager.js` — plan persistence + resume — same module as
  `confluence/html-macro/`
- `test/` — integration tests
- `logs/` — plan files, run logs, identity caches
