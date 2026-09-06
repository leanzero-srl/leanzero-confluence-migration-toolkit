# page-restrictions

Back up and strip **page-level restrictions** on Confluence Data Center so an app-data migration can
run, then restore those restrictions on Cloud afterwards.

## The problem it solves

Several app migrations (Scaffold is the usual one) fail on restricted content with:

> Some data are still not migrated. If these space(s) contain restricted pages, please run the
> migration script provided.

The migration runs as an app user that page restrictions exclude. Restrictions are the blocker, and
the only reliable fix is to remove them for the duration of the migration and put them back after.

## The three scripts

| Script | Side | What it does |
|---|---|---|
| `check_pages.js` | DC | Diagnostic. Given a comma-separated list of content ids, reports whether each exists and what restrictions it carries. Read-only. |
| `remove_restrictions_dc.js` | DC | Scans every space for restricted pages and blogposts, writes a **full backup JSON** of every restriction, then removes them. |
| `restore_restrictions_cloud.js` | Cloud | Reads that backup and re-applies the restrictions on Cloud, resolving DC usernames to Cloud `accountId`s first. |

## Setup

```bash
cd page-restrictions
npm install
cp .env.example .env
```

`.env` needs the DC block (`CONFLUENCE_DC_BASE_URL`, plus either `CONFLUENCE_DC_USERNAME` +
`CONFLUENCE_DC_PASSWORD` or a pre-encoded `CONFLUENCE_DC_BASIC_AUTH`) and, for the restore step, the
Cloud block (`CONFLUENCE_CLOUD_BASE_URL` including `/wiki`, `CONFLUENCE_CLOUD_EMAIL`,
`CONFLUENCE_CLOUD_API_TOKEN`, or `CONFLUENCE_CLOUD_BASIC_AUTH`).

## The order of operations — do not reorder

```bash
# 0. Optional: inspect a few known ids before touching anything.
node check_pages.js 123456790,123456791

# 1. Preview the sweep. Nothing is written.
node remove_restrictions_dc.js --dry-run

# 2. Back up and remove. The backup JSON path is printed — KEEP IT.
node remove_restrictions_dc.js
#    -> backups/restrictions-backup-<timestamp>.json

# 3. Re-run the app migration from the Cloud Migration Assistant. Wait for it to finish.

# 4. Restore the restrictions on Cloud.
node restore_restrictions_cloud.js --backup backups/restrictions-backup-<timestamp>.json
```

`DRY_RUN=true` in `.env` also forces preview mode for the restore step.

## What the backup contains

One entry per restricted content id, with the content type, space key, title, and the full read/update
restriction sets (users **and** groups) exactly as DC reported them. That file is the only way back —
step 2 is not reversible without it.

## Identity translation

Cloud restrictions are keyed by `accountId`, DC restrictions by username. The restore script builds a
`username -> accountId` map by querying the Cloud user-search API before applying anything, and
reports every username it could not resolve rather than silently dropping the grant. Resolve those
by hand before declaring the restore complete.
