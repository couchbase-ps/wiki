# Wiki ops scripts

## cleanup-ignored-pages.js

Deletes already-imported Wiki.js pages that match `.wikiignore`, then optionally
triggers a clean reimport. Requires Node 18+.

### Setup
Create an admin API key in the Wiki.js admin UI: **Administration → API Access →
Create New Key** (scope: full / manage:system). Then:

```bash
export WIKI_GRAPHQL_URL="https://ps-dev.couchbase.com/graphql"
export WIKI_API_KEY="<paste the API key JWT>"
```

### Usage
```bash
# Dry run (default) — lists what WOULD be deleted, deletes nothing:
node scripts/cleanup-ignored-pages.js --wikiignore /path/to/content/.wikiignore

# Apply deletions, then trigger a clean reimport:
node scripts/cleanup-ignored-pages.js --wikiignore /path/to/content/.wikiignore --apply --reimport
```

Notes:
- Handles **pages** only. Assets under ignored paths are prevented by the
  git-storage skip; there are no assets under the current internal folders.
- Idempotent: re-running after a clean state deletes nothing.

### Limitations
The cleanup matcher only honors **plain directory rules** and **plain
top-level `*.md` file rules** in `.wikiignore`. Glob patterns (`*`, `?`, `[`)
and negations (`!...`) are not evaluated — the script prints a warning
listing any such lines, and those pages must be handled manually. This is a
limitation of this one-time cleanup script only: the storage-side skip in
the wiki itself honors full gitignore syntax.
