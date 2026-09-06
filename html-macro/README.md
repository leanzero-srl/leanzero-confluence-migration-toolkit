# Sync HTML Macros: Confluence Data Center to Cloud

When Confluence pages are migrated from Data Center (DC) to Cloud, HTML macros frequently break. The HTML macro app may be unavailable, behave differently, or simply fail to render the original content. Pages end up with "unknown macro" placeholders or mangled HTML where rich content used to be.

This script fixes that. It scans your DC instance for every page containing HTML macros, extracts the raw HTML from the storage format, finds the corresponding page in Cloud, and replaces the broken macro blocks with the original content.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Usage](#usage)
  - [Quick Start](#quick-start)
  - [CLI Options](#cli-options)
  - [Replacement Modes](#replacement-modes)
  - [Workflow Examples](#workflow-examples)
- [Plan Files](#plan-files)
  - [Plan Structure](#plan-structure)
  - [Resume and Retry](#resume-and-retry)
- [How Macros Are Matched and Replaced](#how-macros-are-matched-and-replaced)
- [API Details](#api-details)
- [Performance and Rate Limiting](#performance-and-rate-limiting)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)

---

## How It Works

1. **Scan DC** - Uses CQL (`macro = "html"`) to find all pages containing HTML macros across specified spaces (or all spaces).
2. **Extract HTML** - Parses the Confluence storage format XML to pull out the raw HTML from each `<ac:structured-macro ac:name="html">` block's CDATA section.
3. **Match Cloud Pages** - For each DC page found, looks up the corresponding Cloud page by space key and title using the Confluence Cloud v2 API.
4. **Pre-check** - Compares DC macro content against Cloud macro content. Pages already in sync are skipped automatically, saving API calls and avoiding unnecessary version bumps.
5. **Replace** - Swaps out the broken Cloud macro blocks with the original DC HTML content, then PUTs the updated storage body back to Cloud with an incremented version number.

Only the HTML macro blocks are touched. All surrounding page content (text, images, other macros, layouts, tables) remains exactly as-is.

---

## Architecture

The script follows a **two-phase Plan + Execute** pattern:

```
Phase 1 (Plan)                          Phase 2 (Execute)
┌─────────────────────────┐             ┌─────────────────────────┐
│ Scan DC spaces          │             │ Load plan from JSON     │
│ Extract HTML macros     │             │ Process pending pages   │
│ Match Cloud pages       │  ── save ──>│ Replace macro blocks    │
│ Pre-check sync status   │  plan.json  │ PUT to Cloud API        │
│ Build plan JSON         │             │ Update plan statuses    │
└─────────────────────────┘             └─────────────────────────┘
```

This separation provides several advantages:

- **Inspect before you commit** - Build a plan with `--plan-only`, review the JSON, then execute when ready.
- **Resume from failure** - If the script crashes mid-execution (network issue, rate limit exhaustion), restart with `--resume` and it picks up where it left off. Only `pending` pages are processed.
- **Retry failures** - After a run completes, use `--retry-failed` to reprocess only the pages that errored out.
- **Graceful shutdown** - SIGINT (Ctrl+C) and SIGTERM save the plan to disk before exiting, so no progress is lost.

---

## Prerequisites

- **Node.js** >= 14.x
- **Network access** to both the Confluence DC instance and Confluence Cloud instance
- **DC credentials** - A user account with read access to the spaces you want to scan (Basic Auth: username + password)
- **Cloud credentials** - An Atlassian account email + [API token](https://id.atlassian.com/manage-profile/security/api-tokens) with permission to read and edit pages

---

## Setup

```bash
cd confluence/html-macro

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

Edit `.env` with your actual credentials:

```env
# Confluence Data Center (Basic Auth)
DC_BASE_URL=https://confluence-dc.yourcompany.com
DC_USERNAME=admin
DC_PASSWORD=your_password

# Confluence Cloud (Basic Auth with email:api_token)
CLOUD_BASE_URL=https://yoursite.atlassian.net/wiki
CLOUD_EMAIL=you@company.com
CLOUD_API_TOKEN=your_api_token
```

> **Note:** `CLOUD_BASE_URL` must include `/wiki` (e.g. `https://yoursite.atlassian.net/wiki`). This is the base path for the Confluence Cloud v2 REST API.

---

## Usage

### Quick Start

```bash
# 1. Build a plan for one space (read-only, no changes made)
node main/sync_html_macros.js --plan-only --space PROJ

# 2. Review the plan
cat logs/plan_*.json | python3 -m json.tool | head -50

# 3. Dry run - simulates execution without making changes
node main/sync_html_macros.js --dry-run --space PROJ

# 4. Execute for real
node main/sync_html_macros.js --space PROJ
```

### CLI Options

| Option | Description | Default |
|---|---|---|
| `--dry-run` | Preview what would be updated. No Cloud pages are modified. | off |
| `--space <KEY>` | Filter to specific space(s). Repeatable or comma-separated: `--space PROJ1,PROJ2` | all spaces |
| `--limit <n>` | Limit total pages to process across all spaces. | unlimited |
| `--plan-only` | Build the plan and save it, then stop. Does not execute Phase 2. | off |
| `--execute-only` | Load the most recent (or specified) plan and execute. Skips Phase 1. | off |
| `--resume` | Alias for `--execute-only`. | off |
| `--plan-file <path>` | Path to a specific plan JSON file to load for execution. | latest in `logs/` |
| `--concurrency <n>` | Max parallel Cloud API requests during execution. | 3 |
| `--retry-failed` | Also reprocess pages with status `failed` (default: only `pending`). | off |
| `--replacement-mode <mode>` | How to replace macros: `raw` or `macro`. See below. | `raw` |
| `--space-type <kind>` | When `--space` is NOT given, restrict DC space enumeration. Values: `sites` (site/global only), `personal` (DC `~user` spaces only), `all` (both). Ignored if `--space` is provided. | `sites` |
| `--help` | Show full help text with examples. | - |

> **Why `--space-type` defaults to `sites`:** Confluence Cloud has no personal spaces — only site spaces survive a DC→Cloud migration. Scanning DC personal spaces by default would burn API calls fetching pages that can never match Cloud. Use `--space-type personal` only if you have a specific reason (e.g. you've migrated a personal space's pages into a real site space and want to also sync those DC source pages by some other matching scheme).

### Replacement Modes

The script supports two replacement strategies depending on whether the HTML macro app is installed in your Cloud instance:

#### `raw` (default)

Replaces the **entire** `<ac:structured-macro ac:name="html">...</ac:structured-macro>` block with the raw HTML content from DC. The macro wrapper is removed entirely and the HTML is placed inline in the page body.

**Use when:** The HTML macro app is **NOT** installed in Cloud, or you want the HTML to render natively without depending on any app.

```
Before (Cloud):
  <ac:structured-macro ac:name="html" ...>
    <ac:plain-text-body><![CDATA[<div>broken or empty</div>]]></ac:plain-text-body>
  </ac:structured-macro>

After:
  <div>original content from DC</div>
```

#### `macro`

Preserves the `<ac:structured-macro ac:name="html">` wrapper but replaces the CDATA content inside `<ac:plain-text-body>` with the DC version.

**Use when:** The HTML macro app **IS** installed in Cloud and working, but the content inside the macros was corrupted or lost during migration.

```
Before (Cloud):
  <ac:structured-macro ac:name="html" ...>
    <ac:plain-text-body><![CDATA[<div>broken or empty</div>]]></ac:plain-text-body>
  </ac:structured-macro>

After:
  <ac:structured-macro ac:name="html" ac:schema-version="1" ac:macro-id="...">
    <ac:plain-text-body><![CDATA[<div>original content from DC</div>]]></ac:plain-text-body>
  </ac:structured-macro>
```

### Workflow Examples

**Scan a single space, limited to 10 pages:**
```bash
node main/sync_html_macros.js --plan-only --space PROJ --limit 10
```

**Full sync across multiple spaces in dry-run:**
```bash
node main/sync_html_macros.js --dry-run --space PROJ1,PROJ2,PROJ3
```

**Execute an existing plan with higher concurrency:**
```bash
node main/sync_html_macros.js --execute-only --concurrency 5
```

**Resume from a specific plan file after a failure:**
```bash
node main/sync_html_macros.js --resume --plan-file ./logs/plan_1710000000000.json
```

**Retry only the failed pages from a previous run:**
```bash
node main/sync_html_macros.js --resume --retry-failed
```

**Full sync of all spaces with macro mode (HTML macro app installed in Cloud):**
```bash
node main/sync_html_macros.js --replacement-mode macro
```

**Scan only personal spaces in DC (rare):**
```bash
node main/sync_html_macros.js --plan-only --space-type personal
```

**Scan everything in DC (sites + personal):**
```bash
node main/sync_html_macros.js --plan-only --space-type all
```

---

## Plan Files

Plans are saved as JSON files in the `logs/` directory, named `plan_<timestamp>.json`. They contain everything needed to execute (or re-execute) the sync operation.

### Plan Structure

```json
{
  "version": "1.0",
  "runId": "1710000000000",
  "createdAt": "2026-03-17T10:00:00.000Z",
  "updatedAt": "2026-03-17T10:05:00.000Z",
  "stats": {
    "total": 150,
    "pending": 12,
    "completed": 130,
    "failed": 5,
    "skipped": 3
  },
  "pages": {
    "12345": {
      "status": "completed",
      "spaceKey": "PROJ",
      "title": "Some Page Title",
      "dcPageId": "12345",
      "cloudPageId": "67890",
      "htmlMacros": [
        {
          "index": 0,
          "dcContent": "<div class=\"custom-panel\">...</div>"
        }
      ],
      "macroCount": 1,
      "error": null,
      "updatedAt": "2026-03-17T10:03:12.000Z"
    }
  }
}
```

Each page entry tracks:

| Field | Description |
|---|---|
| `status` | One of: `pending`, `completed`, `failed`, `skipped` |
| `spaceKey` | Confluence space key |
| `title` | Page title (used for matching DC to Cloud) |
| `dcPageId` | DC page ID (plan key) |
| `cloudPageId` | Corresponding Cloud page ID |
| `htmlMacros` | Array of extracted HTML macro contents from DC, ordered by position |
| `macroCount` | Number of HTML macros on this page |
| `error` | Error message if status is `failed`, null otherwise |
| `updatedAt` | Timestamp of last status change |

### Resume and Retry

When resuming (`--execute-only` or `--resume`):
- Only pages with `status: "pending"` are processed by default.
- Add `--retry-failed` to also reprocess pages with `status: "failed"`.
- Pages with `status: "completed"` or `status: "skipped"` are never reprocessed.
- The plan file is updated in-place as execution progresses, with periodic saves every 50 pages.

---

## How Macros Are Matched and Replaced

### Extraction

HTML macros in Confluence storage format look like this:

```xml
<ac:structured-macro ac:name="html" ac:schema-version="1" ac:macro-id="abc-123">
  <ac:plain-text-body><![CDATA[
    <div class="custom-panel">
      <h2>Hello World</h2>
      <p>This is custom HTML content.</p>
    </div>
  ]]></ac:plain-text-body>
</ac:structured-macro>
```

The script extracts the content inside `<![CDATA[...]]>` using regex. It handles two variants:
1. **CDATA-wrapped** (most common) - content inside `<![CDATA[...]]>`
2. **Plain text body** (fallback) - content directly inside `<ac:plain-text-body>...</ac:plain-text-body>` without CDATA

### Matching Strategy

Macros are matched between DC and Cloud pages by **ordinal position**:
- DC macro #1 maps to Cloud macro #1
- DC macro #2 maps to Cloud macro #2
- etc.

If the macro counts differ between DC and Cloud, the script matches as many as possible (up to the smaller count) and logs a warning.

### Pre-check Optimization

During the plan phase, the script compares DC and Cloud macro content for each page. If all macros already have identical content (after whitespace trimming), the page is marked as "already in sync" and excluded from the plan entirely. This avoids unnecessary API calls during execution and prevents creating pointless page versions in Cloud.

### What Gets Changed

Only the HTML macro blocks themselves are modified. The replacement operates on the raw storage format XML string:

- In `raw` mode: the entire `<ac:structured-macro ac:name="html">...</ac:structured-macro>` element is replaced with the DC HTML content.
- In `macro` mode: only the content inside `<![CDATA[...]]>` is swapped.

Everything else on the page - text, images, tables, layouts, other macros, metadata - is untouched.

---

## API Details

### Data Center (REST API v1)

| Operation | Endpoint |
|---|---|
| Test connection | `GET /rest/api/space?limit=1` |
| Search for HTML macros | `GET /rest/api/content/search?cql=space="KEY" AND macro="html" AND type=page&expand=body.storage,version,space` |
| Get page content | `GET /rest/api/content/{id}?expand=body.storage,version,space` |
| List all spaces | `GET /rest/api/space?limit=100&start=N` |

Authentication: Basic Auth (`username:password`).

### Cloud (REST API v2)

| Operation | Endpoint |
|---|---|
| Test connection | `GET /api/v2/spaces?limit=1` |
| Resolve space key to ID | `GET /api/v2/spaces?keys=KEY&limit=1` |
| Find page by space + title | `GET /api/v2/pages?space-id=ID&title=TITLE&body-format=storage&limit=1` |
| Get page content | `GET /api/v2/pages/{id}?body-format=storage` |
| Update page | `PUT /api/v2/pages/{id}` with `{id, status, title, body: {representation, value}, version: {number, message}}` |

Authentication: Basic Auth (`email:api_token`).

> The Cloud client uses the **v2 API** exclusively. The v2 API uses numeric space IDs (not space keys), so the client resolves and caches `spaceKey -> spaceId` mappings automatically.

---

## Performance and Rate Limiting

### Concurrency

The script uses a worker pool pattern for parallel API calls. The `--concurrency` flag controls the number of simultaneous Cloud API requests (default: 3, lower than the Jira scripts because Confluence Cloud has stricter rate limits).

Concurrency is applied in two places:
1. **Plan phase** - Cloud page lookups (finding pages by space + title) run in parallel.
2. **Execute phase** - Cloud page updates (GET current + PUT new) run in parallel.

### Retry and Backoff

Both the DC and Cloud clients implement **exponential backoff** with separate counters for rate limits and server errors:

| Scenario | Max Retries | Backoff |
|---|---|---|
| DC rate limit (429) | 5 | `5s * 2^attempt` (max 120s), or `Retry-After` header |
| DC server error (5xx) | 3 | `1s * 2^attempt` (max 10s) |
| DC connection error/timeout | 3 | `2s * (attempt + 1)` |
| Cloud rate limit (429) | 3 | `5s * 2^attempt` (max 60s), or `Retry-After` header |
| Cloud server error (5xx) | 3 | `1s * 2^attempt` (max 10s) |
| Cloud connection error/timeout | 3 | `2s * (attempt + 1)` |

### Version Conflict Handling

If a Cloud page is edited by someone else between the plan phase and execution (or between GET and PUT), the API returns `409 Conflict`. The script handles this by re-fetching the current version and retrying the PUT once with the updated version number.

---

## Troubleshooting

### "Missing required environment variables"
Copy `.env.example` to `.env` and fill in all six values. The `CLOUD_BASE_URL` must include `/wiki`.

### "Cannot connect to Confluence Datacenter / Cloud"
- Verify the URLs are correct and reachable from where you're running the script.
- Check that credentials are valid (test with `curl`).
- For Cloud, ensure the API token hasn't expired.

### Pages not found in Cloud
Pages are matched by **space key + exact title**. If a page was renamed during or after migration, the match will fail. Check the plan JSON for pages with `"cloudPageId": null`.

### Macro count mismatch warnings
If a DC page has 3 HTML macros but the Cloud page only has 2 (or vice versa), the script matches as many as possible by position and logs a warning. This can happen if macros were added or removed post-migration. Review these pages manually.

### Rate limit exhaustion
If you're hitting rate limits frequently:
- Lower `--concurrency` to 1 or 2.
- Run during off-peak hours.
- Process spaces in smaller batches using `--space` and `--limit`.

### Resuming after a crash
The plan file is saved periodically (every 50 pages) and on graceful shutdown (Ctrl+C). To resume:
```bash
node main/sync_html_macros.js --resume
```
This loads the latest plan and processes only remaining `pending` pages.

---

## File Structure

```
confluence/html-macro/
├── .env.example                       # Environment variable template
├── .env                               # Your actual credentials (git-ignored)
├── package.json                       # Dependencies (dotenv only)
├── README.md                          # This file
├── main/
│   └── sync_html_macros.js            # Entry point, CLI parsing, orchestration
├── src/
│   ├── datacenterConfluenceClient.js  # DC REST API v1 client with retry/backoff
│   ├── cloudConfluenceClient.js       # Cloud REST API v2 client with retry/backoff
│   ├── htmlMacroProcessor.js          # Core logic: extract, match, replace macros
│   └── planManager.js                 # Plan creation, persistence, resume support
└── logs/                              # Runtime output (plans, logs)
    ├── plan_<timestamp>.json          # Plan files (generated at runtime)
    └── sync_<timestamp>.log           # Execution logs (generated at runtime)
```
