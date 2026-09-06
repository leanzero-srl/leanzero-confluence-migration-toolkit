# grant-space-admin

Adds the account behind your API token as an **administrator on every Confluence Cloud space**.

## Why it exists

Most of the other scripts in this toolkit have to **write page bodies**. Confluence Cloud enforces
that per space, and a site admin is *not* automatically a space admin — a site admin can see a space
in the admin console and still get `403` on `PUT /wiki/api/v2/pages/{id}`. Running this once turns a
site-admin token into a token that can actually edit every page, which is the precondition for
`html-macro`, `nested-macro`, `visibility-macro`, `composition-tabs` and `responsibility-to-aura`.

It is **additive only** — it never removes an existing permission — and **idempotent**: spaces that
already carry the target permissions are skipped.

## Endpoints used

| Call | Purpose |
|---|---|
| `GET /wiki/rest/api/user/current` | resolve the token's own `accountId` |
| `GET /wiki/api/v2/spaces` | enumerate every space (paginated) |
| `GET /wiki/api/v2/spaces/{id}/permissions` | read what we already hold |
| `POST /wiki/rest/api/space/{spaceKey}/permission` | grant one permission |

The v1 grant endpoint is the only documented way to add a space permission from a **user API token**.
Forge and Connect apps cannot call it; Basic-auth user tokens can. The caller must already be a
space admin or hold *Administer Confluence*.

## Setup

```bash
cd grant-space-admin
npm install
cp .env.example .env       # CLOUD_BASE_URL (include /wiki), CLOUD_EMAIL, CLOUD_API_TOKEN
```

## Run

```bash
# 1. See what would be granted, change nothing.
node main/grant_space_admin.js --dry-run

# 2. Scope it to a couple of spaces first and confirm in the UI.
node main/grant_space_admin.js --space DOCS,TEAM

# 3. Whole site, skipping personal spaces.
node main/grant_space_admin.js --skip-personal
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Enumerate and report, send no `POST`. |
| `--space <KEY>` | all | Restrict to space key(s); repeatable or comma-separated. |
| `--skip-personal` | off | Exclude personal spaces (keys starting with `~`). |
| `--full-grant` | off | Grant the full admin-equivalent operation set instead of just `administer:space` + `read:space`. |
| `--concurrency <N>` | 3 | Parallel workers. |
| `--help` | — | Usage. |

A timestamped log is written to `logs/grant_<epoch>.log` on every run.

## Undo

There is no automatic revert. Because the script is additive, the undo is to remove the granted
permissions from **Space settings → Permissions** for the spaces listed in the run log, or to call
`DELETE /wiki/rest/api/space/{key}/permission/{id}` with the ids the log records.
