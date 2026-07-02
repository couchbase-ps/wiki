# Well-Architected Review Editor Integration — Design Spec

**Date:** 2026-07-02  
**Status:** Approved  
**Author:** Tayeb Chlyah

---

## Goal

Integrate the Couchbase Well-Architected Review (WAR) HTML tool into the Wiki.js markdown editor, following the exact pattern already used for the Maturity Matrix integration. Users can start a new review or edit an existing one via a visual editor; the result is stored in the wiki page and re-openable losslessly.

Reference implementation to clone: the Maturity Matrix feature (`2026-05-08-maturity-matrix-editor-integration-design.md`).

---

## Context

The Well-Architected Review tool currently lives as a standalone static SPA hosted on S3 (`couchbase-well-architected-tool.s3-website.eu-west-3.amazonaws.com`). It is a multi-file app: an HTML shell, `app.js`, `app.css`, a `pillars.json` data file, and a logo. The user answers checklist questions across 6 pillars (Operational Excellence, Security, Reliability, Performance Efficiency, Cost Optimization, Data Management & Consistency), with optional per-question notes, then submits to see a risk/coverage dashboard and per-pillar recommended improvements.

The Maturity Matrix feature is the reference pattern:
- An editor toolbar button opens a full-screen modal hosting a self-contained static tool in an iframe.
- The tool communicates with the Vue component via `postMessage` (`ready` / `init` / `save` / `exit`).
- The result is stored in the page markdown wrapped in HTML-comment sentinels.
- `processMarkers` in the markdown editor detects the stored block and renders an inline "Edit" button.
- Rendering uses the standard Wiki.js pipeline — no custom server renderer, no GraphQL, no config.

Two deliberate deviations from the Maturity Matrix pattern, driven by the shape of WAR data:
1. **Persistence is lossless via hidden JSON**, not by re-parsing the visible report. WAR state (checkbox selections + notes across many questions/pillars) is awkward and lossy to reconstruct from a prose report, so the canonical answer state is embedded as hidden JSON and the round-trip parser is a simple JSON read.
2. **The tool's own localStorage draft persistence is removed.** The saved wiki markdown block becomes the single source of truth; the tool holds working state in memory only for the duration of one modal session.

---

## Storage Format

When saved, the wiki page contains a single block: canonical answer state hidden inside the opening HTML comment, followed by a human-readable full-review report, closed by the end sentinel.

```
<!--well-architected
{ canonical review state as JSON: workload name, review name, and the full answers map (per pillar/question: selected practices, none-of-these flag, notes) }
-->
# Couchbase Well-Architected Review

**Workload:** <value>  **Review:** <value>

## Overview
<risk counts High/Medium/Low, coverage, answered/total>

## <Pillar Name> — Recommended Improvements
<per-improvement: title, severity, description, suggested next steps, doc link>

... (all 6 pillars) ...
<!--/well-architected-->
```

- The opening-comment JSON is the **only** source used to reload the review on Edit — lossless.
- The visible report is rendered by the standard pipeline (headings, tables, links). The HTML comments render to nothing.
- The visible report covers the **full review, all pillars** (the standalone tool today reports only the current pillar; this must be extended).

---

## Components

### New files
- **`client/static/well-architected/`** — the vendored WAR tool (HTML shell, `app.js`, `app.css`, `pillars.json`, logo). Served same-origin at `/_assets/well-architected/` via the existing static-asset copy step. No external host, no config URL.
- **`client/components/editor/editor-modal-wellarchitected.vue`** — the modal: a full-screen card hosting the iframe plus the `postMessage` bridge. Cloned from the Maturity Matrix modal.

### Modified files
- **`client/components/editor.vue`** — register the new modal component.
- **`client/components/editor/editor-markdown.vue`** — add the toolbar button and open handler; add a new insert case for the Well-Architected kind; add a new sentinel branch in `processMarkers`. The marker-scanning loop now handles three block types — the new branch must not collide with the existing state.
- **`server/middlewares/security.js`** — extend the X-Frame-Options same-origin exception to cover the new asset path (same rationale as Maturity Matrix — the iframe is same-origin and must be allowed to frame).

---

## Tool Modifications (vendored `app.js` / HTML shell)

- **Add the postMessage bridge:** emit `ready` on load; handle `init`; emit `save` and `exit`. (None of this exists today.)
- **Replace the "Generate Markdown Report" affordance with a "Save" button.** Remove the in-tool markdown preview entirely — the tool never displays raw markdown. Save is disabled until a successful Submit Review (same gating the old Generate button used). Save serializes the review, sends it to the editor, and closes the modal.
- **Save always serializes all pillars**, regardless of which pillar is active. Submit Review remains as the in-tool validation + dashboard preview step.
- **Remove localStorage persistence.** Working state lives in memory for the session. On `init` with existing state, hydrate from the injected JSON and render; on `init` with no state, start empty. "Start New Review" resets the in-memory state only.
- **Deserialization is a JSON read** of the hidden opening-comment payload — no prose re-parsing.

---

## Data Flow

**Insert:** toolbar button → open modal + iframe → iframe `ready` → parent sends `init` (no state) → user answers → Submit Review → Save enabled → Save → tool builds block (hidden JSON + full report) → `save` postMessage → parent wraps in sentinels and inserts into the editor → modal closes.

**Edit:** `processMarkers` detects the sentinels → renders inline "Edit Well-Architected Review" widget → click extracts the hidden JSON → passed as `activeModalData` → modal reopens → iframe `ready` → parent sends `init` with the state → tool rebuilds all answers and re-renders.

**Render (published page):** sentinels are invisible HTML comments; the inner report is plain markdown rendered by the standard Wiki.js pipeline. No Well-Architected-specific renderer.

---

## Out of Scope

- No server-side renderer, GraphQL schema/resolver, or database migration.
- No config keys or environment variables.
- No changes to the standalone tool's own hosting; the S3 copy is unaffected. The vendored copy is what the wiki uses.
