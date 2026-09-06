# LeanZero Confluence Migration Toolkit

Seven Node.js tools that repair **Confluence Cloud content after a Data Center migration** — the
macros, the page bodies and the permissions that the Cloud Migration Assistant does not carry across
intact.

Apache-2.0. No dependencies beyond `dotenv` (and `fast-xml-parser` where XHTML has to be parsed).
Every tool talks to the public REST API over Node's built-in `https` — nothing to install on a server,
nothing to deploy into the tenant.

---

## The problem this exists for

A Confluence DC→Cloud migration moves pages. It does not guarantee that what is *inside* the pages
still works. Four things break predictably, and none of them appear in the migration report:

1. **App macros whose Cloud build differs** — the macro name in storage format changes, or the Cloud
   version of the app expects different parameters, and the page renders an "Unknown macro"
   placeholder where the content used to be.
2. **App macros with no Cloud build at all** — the original XML survives in page storage, unrendered
   and unreachable, forever.
3. **Nested bodied macros** — legal on DC, unsupported by Cloud's Fabric editor. The page renders
   wrong and the editor refuses to open it.
4. **Identity-shaped parameters** — anything storing a DC username or group name stops resolving,
   because Cloud is keyed on `accountId` and `groupId`.

Each tool here fixes exactly one of those, and every one of them is a **storage-format rewrite**:
discover the affected pages, parse the XHTML, splice in the change, back up the original, PUT it
back. Nothing is regenerated; everything else on the page stays byte-identical.

---

## What is in the box

| Tool | Fixes | Direction |
|---|---|---|
| [`html-macro`](./html-macro) | HTML macros that arrive broken or unrendered. Extracts the raw HTML from the DC storage format and replaces the broken macro block on Cloud with the original content. | DC → Cloud |
| [`nested-macro`](./nested-macro) | Nested bodied macros. Rewrites them so the previously-nested macro becomes a sibling, using a split-around-child strategy that handles arbitrary depth. | Cloud only |
| [`visibility-macro`](./visibility-macro) | *Show If* / *Hide If* macros whose `users` and `user-groups` parameters still hold DC usernames and group names. Resolves them to Cloud `accountId` / `groupId`. | DC → Cloud |
| [`composition-tabs`](./composition-tabs) | Deck-of-Cards / Card macros that land under names colliding with Cloud natives, so the page stops rendering. Rewrites them to the Cloud-compatible legacy equivalents. | Cloud only |
| [`responsibility-to-aura`](./responsibility-to-aura) | Content-Responsibility macros from a Server-only app with no Cloud build. Converts them into an equivalent Cloud macro, keeping the responsible users. | Cloud only |
| [`page-restrictions`](./page-restrictions) | App migrations that fail on restricted pages. Backs up and strips DC page restrictions, then restores them on Cloud. | DC → Cloud |
| [`grant-space-admin`](./grant-space-admin) | The precondition for everything above: makes your API-token account a space admin on every space, so the `PUT`s are actually allowed. | Cloud only |

---

## Start here

```bash
git clone https://github.com/leanzero-srl/leanzero-confluence-migration-toolkit.git
cd leanzero-confluence-migration-toolkit/grant-space-admin
npm install
cp .env.example .env        # CLOUD_BASE_URL (with /wiki), CLOUD_EMAIL, CLOUD_API_TOKEN
node main/grant_space_admin.js --dry-run
```

Being a site admin is **not** enough to edit every page. Run `grant-space-admin` first, or the other
six tools will spend a long run collecting `403`s.

---

## How every tool in this repo behaves

The same operating model, deliberately, so that knowing one means knowing all seven.

**Two phases, always.** A read-only **plan** phase discovers affected pages and writes a reviewable
JSON plan. An **execute** phase acts on that plan. `--dry-run` runs the second phase without the
`PUT`. You are expected to read the plan before you run it.

**Backups before every write.** Each modified page gets its original storage XHTML, a unified diff,
and a metadata JSON written under `backups/` before the new version is sent. That directory is the
undo.

**Default-deny on ambiguity.** Where a page could legitimately be either shape, the tool skips it and
records the reason rather than guessing. A skipped page you can fix by hand is cheaper than a
corrupted page nobody notices.

**Idempotent and resumable.** Re-running is safe; already-converted pages are detected and skipped,
and an interrupted run resumes from its plan file.

**Discovery is CQL.** Which means it is only as good as the index. Confirm the shape of the macro on
*your* tenant before a full run — most tools have a `--discovery-dump` or equivalent that prints the
raw storage XML of a handful of matches. Use it. Storage format varies by app version.

---

## The rule that matters

Run every tool against **one space, then one page**, and open the result in a browser before you let
it near the site. A storage-format rewrite that is syntactically valid and semantically wrong writes
successfully, reports success, and renders as an empty box. The API will not tell you. Only the page
will.

---

## Licence

Apache-2.0. See [LICENSE](./LICENSE).

Built by [LeanZero](https://leanzero.net) during real Atlassian Cloud migrations, and open-sourced so
the next team does not have to rediscover the same storage-format edge cases.
