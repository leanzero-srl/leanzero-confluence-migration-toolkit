# confluence/responsibility-to-aura

Cloud-only converter: **Linchpin "Content Responsibility"** macros (Server/DC-only app by //SEIBERT/MEDIA) → **"Aura User Profile"** macros (Forge Cloud app by Aura Apps).

After a Confluence DC → Cloud migration, pages that used Linchpin's Responsibility macro show as "Unknown macro" placeholders in Cloud (Linchpin has no Cloud build). The original `<ac:structured-macro …>` XML is preserved in page storage, so this script can CQL-discover those pages and PUT a replacement Aura User Profile macro in place, keeping the responsible users.

## Quick start

```bash
cd confluence/responsibility-to-aura
npm install
cp .env.example .env
# edit .env with your Cloud tenant URL, email, and API token

# 1. DISCOVERY — dump raw storage XML of N matching pages, then exit.
#    Use this first to confirm the exact ac:name and parameter shape on
#    your tenant. Output goes to logs/discovery_<runId>/
node main/sync_responsibility_to_aura.js --discovery-dump --space TEST --limit 5

# 2. DRY-RUN — build a plan, resolve user identities via Jira, write
#    backups + diffs, but skip the PUT step. Inspect backups/*.diff.patch.
node main/sync_responsibility_to_aura.js --dry-run --space TEST --limit 1

# 3. APPLY — same as dry-run but actually PUTs the new storage.
node main/sync_responsibility_to_aura.js --space TEST --limit 1

# 4. ROLLBACK — uses Confluence's native version-restore API.
node main/restore_responsibility_to_aura.js --plan-file logs/plan_<id>.json --dry-run
node main/restore_responsibility_to_aura.js --plan-file logs/plan_<id>.json
```

## Required env (`.env`)

```
CLOUD_BASE_URL=https://your-tenant.atlassian.net/wiki
CLOUD_EMAIL=you@example.com
CLOUD_API_TOKEN=your-cloud-api-token
```

The API token must be from a user with:
- Confluence permission to edit every page in scope (preflight: try editing one manually)
- Jira "Browse users and groups" global permission (needed for `/rest/api/3/user/search` to resolve user tokens → accountIds)

## How user resolution works

Linchpin macros in DC referenced users by `userkey` or `username`; Cloud needs `accountId`. The script:

1. Walks the source macro's `users` parameter, accepting three shapes:
   - `<ri:user ri:account-id="..."/>` (already migrated)
   - `<ri:user ri:userkey="..."/>` (DC userkey survives migration)
   - `<ri:user ri:username="..."/>` (legacy)
   - Plain comma-separated text (`alice,bob,carol`)
2. Resolves each unique token via Jira's `GET /rest/api/3/user/search?query=<token>` (the only post-GDPR mechanism to map a free-text token → accountId).
3. Caches results in `logs/user_id_cache.json` so a re-run never re-hits the API for the same token.
4. Optionally overrides via a CSV file (`--user-mapping users.csv`, format `token,accountId`) for tokens that the API can't resolve (legacy userkeys, deactivated users, etc.).
5. **If any token on a page is unresolvable, the whole page is skipped** and every unresolved token is logged to `logs/unresolved_users_<runId>.csv`. Manual review required before re-running with overrides.

## Mapping behaviour

- **>10 users in source**: emit ceil(N/10) Aura macros side-by-side, each with up to 10 users (Aura's documented limit).
- **Lossy parameters** (`additionalInformation`, `width`, etc.): dropped from output; every drop is logged to `logs/lossy_params_<runId>.csv` with page id, macro id, and original value.

## Outputs

- `logs/sync_<runId>.log` — per-line action log
- `logs/plan_<runId>.json` — page-by-page plan with status, macros, resolved accountIds, errors
- `logs/user_id_cache.json` — persistent token → accountId cache, reused across runs
- `logs/unresolved_users_<runId>.csv` — tokens we couldn't resolve
- `logs/lossy_params_<runId>.csv` — Linchpin params Aura has no equivalent for
- `logs/discovery_<runId>/page_<id>_v<v>.xhtml` + `.macros.json` — discovery-dump artifacts
- `backups/page_<id>_v<v>.xhtml` + `.diff.patch` + `.meta.json` — per-page snapshots before each PUT

## Tuning the source/target macro names

Defaults are best-effort guesses based on Atlassian plugin naming conventions because Linchpin's storage-format XML isn't publicly documented. After `--discovery-dump`, inspect the dumped `.xhtml` files and (if needed) override:

```bash
node main/sync_responsibility_to_aura.js \
  --source-macro-name content-responsibility \
  --source-users-param responsibleUsers \
  --target-macro-name aura-user-profile-card \
  --target-users-param userIds \
  --target-users-ri-user \
  --dry-run --space TEST --limit 1
```

## Architecture

- `src/cloudConfluenceClient.js` — HTTPS, retry (429/5xx/timeout), CQL pagination, GET storage, PUT storage with 409 retry, native version restore, Jira user-search bypassing the `/wiki` basePath.
- `src/identityResolver.js` — User-only token → accountId resolver via Jira user-search with on-disk + in-memory cache + CSV mapping override.
- `src/responsibilityMacroProcessor.js` — Splice-rewrite engine. Pure string manipulation, no XML parser. Finds source macros, extracts user tokens, builds chunked Aura replacements, splices back-to-front.
- `src/planManager.js` — Stream-writing plan JSON with auto-save every 50 mutations.
- `main/sync_responsibility_to_aura.js` — CLI orchestrator: discovery, plan, resolve, execute, verify.
- `main/restore_responsibility_to_aura.js` — Rollback via Confluence's native version-restore, with `--from-backup` fallback.

Modelled after `confluence/composition-tabs` (storage-format splice rewrite) and `confluence/visibility-macro` (identity resolution pattern).
