---
story_id: "3.2"
story_key: "3-warm-cache"
epic: 3
status: wont-do
created: 2026-06-08
baseline_commit: 0f1ed6901fcaa7e375b69e67452c5456585c4362
---

# Story 3.2: Tool `deepgrep_warm` — Pre-warm search cache

## Story

As a developer (or AI agent) working repeatedly on the same repo,
I want to pre-warm the search cache (precompute repo map + mtime hash) for a project,
so that my first real query doesn't pay the repo-map build cost.

## Context & Decision (ADR-7)

- Expose as an **MCP tool `deepgrep_warm`** (pattern like `deepgrep_status`), NOT a CLI subcommand. deepgrep is a stdio MCP server, not a CLI app.
- Pure local — no API key needed (same posture as `deepgrep_get`). Warming computes `getRepoMap` + `computeMtimeHash` and reports timing; it does NOT call the search API.
- Scope is intentionally small: precompute + cache the repo map so the first `deepgrep_search` reuses it instead of rebuilding.

## Acceptance Criteria

- **AC1:** Given `{project_path}`, When `deepgrep_warm` is called, Then it computes the repo map (`getRepoMap`) + mtime hash (`computeMtimeHash`) and returns a summary (tree depth used, tree size KB, file count / mtime hash, elapsed ms) WITHOUT calling the search API.
- **AC2:** Given no API key is set, Then `deepgrep_warm` still works (pure local — never reads DEEPGREP_API_KEY / WINDSURF_API_KEY).
- **AC3:** Given `project_path` omitted/empty, Then default to `process.cwd()` (same default as `deepgrep_search`).
- **AC4:** Given `tree_depth` / `exclude_paths` params, Then they are forwarded to `getRepoMap` (1-6 clamp for depth, same as search).
- **AC5:** Given an invalid / non-existent `project_path`, Then return a clear error message, NOT a crash (try/catch → text response).
- **AC6:** Given warm completes, Then the precomputed repo map is stored so a subsequent identical `deepgrep_search` (same project_path + tree_depth + exclude_paths, unchanged files) reuses it (warm-state observable via a `warmed=true` / cache marker — see Dev Notes for chosen mechanism).
- **AC7:** Output format: human-readable status block, e.g.
  ```
  deepgrep warm — /path/to/project
  ✅ Repo map: tree -L 3 (33.4KB)
  ✅ Mtime hash: a1b2c3… (412 files)
  ⏱  Warmed in 96ms
  ```

## Tasks

### T1. Register tool `deepgrep_warm` in `deepgrep/src/server.mjs`

- [ ] Add tool after `deepgrep_status`, before `deepgrep_get` (keep pure-local tools grouped)
- [ ] Schema (match `deepgrep_search` param names/shapes):
  ```js
  {
    project_path: z.string().default("").describe("Absolute path to project root (default: cwd)"),
    tree_depth: z.number().int().min(1).max(6).default(3).describe("Directory tree depth for repo map"),
    exclude_paths: z.array(z.string()).default([]).describe("Patterns to exclude (e.g. ['node_modules','dist'])"),
  }
  ```
- [ ] Description: `"Pre-warm the search cache for a project: precompute repo map + mtime hash so the first deepgrep_search is faster. No API key required — pure local."`
- [ ] Handler:
  - Resolve `projectRoot = project_path || process.cwd()`
  - Call `getRepoMap(projectRoot, tree_depth, exclude_paths)` → `{tree, depth, sizeBytes, fellBack}`
  - Call `computeMtimeHash(projectRoot, exclude_paths)` → hash string
  - Store warm state (see Dev Notes — chosen mechanism)
  - Format summary per AC7
  - Wrap in try/catch → friendly error text (AC5)
- [ ] Export the formatter (e.g. `formatWarmOutput`) like `formatSnippetToolOutput` is exported, so it can be unit-tested directly.

### T2. Unit test `deepgrep/test/warm-tool.test.mjs` (mirror in repo `test/`)

- [ ] AC1: returns summary with tree size + mtime info + elapsed ms, no network
- [ ] AC2: works with DEEPGREP_API_KEY / WINDSURF_API_KEY unset
- [ ] AC3: empty project_path → defaults to cwd (use a temp project dir via `helpers/test-project.mjs`)
- [ ] AC4: tree_depth + exclude_paths forwarded (assert excluded dir absent from tree)
- [ ] AC5: non-existent path → error text, no throw
- [ ] AC7: output format matches header + checkmark lines
- [ ] Pattern: `node:test`, temp dirs via `createTestProject`, follow `snippets-tool.test.mjs` style

### T3. MCP integration coverage

- [ ] Add a case to `test/mcp-integration.test.mjs`: `tools/list` now returns 5 tools (add `deepgrep_warm`)
- [ ] Add a `tools/call` case: `deepgrep_warm` on the repo root returns a status block (regex assert on "deepgrep warm")

### T4. Verify

- [ ] `node --check deepgrep/src/server.mjs`
- [ ] `node --test 'test/**/*.test.mjs'` — all pass incl. new tests
- [ ] Manual: call `deepgrep_warm` then `deepgrep_search` on same path → confirm reuse marker

## Dev Notes

### Reuse — DO NOT reimplement

| Need | Reuse | From |
|------|-------|------|
| Repo map (tree -L, fallback, size) | `getRepoMap(projectRoot, depth, excludePaths)` | `shared.mjs:58` |
| File-content hash | `computeMtimeHash(projectRoot, excludePaths)` | `cache.mjs:54` |
| Cache key | `buildCacheKey({...})` | `cache.mjs:95` |

`getRepoMap` already handles depth fallback + `MAX_TREE_BYTES`. `computeMtimeHash` already caps at 5000 files. Warm tool is a thin orchestrator + formatter — no new algorithms.

### Warm-state mechanism (AC6) — choose during dev

Two viable options; pick the lower-risk one that satisfies AC6:

- **Option A (recommended, minimal):** Add a tiny in-memory repo-map cache in `shared.mjs` keyed by `(projectRoot, depth, excludePaths)`. `getRepoMap` checks it first; `deepgrep_warm` populates it. First `deepgrep_search` then skips the `treeNodeCli` call. Smallest blast radius, observable via timing.
- **Option B:** Pre-insert nothing into result cache (can't — no search result yet). Only the repo map can be warmed, so Option A is the natural fit.

Document the chosen mechanism + the `warmed`/reuse marker in the story Dev Agent Record on completion.

### Constraints

- NFR3: no new dependencies — pure JS + existing imports only.
- NFR4: backward compatible — new tool, no change to existing tool signatures.
- Pure local: never read API-key env vars in this path (AC2). Mirror `deepgrep_get`'s no-key posture.
- `deepgrep` is an open-source submodule — edits land there and require a submodule commit + parent pointer bump (same flow as story 3.1).

### Test import note

Repo `test/*.test.mjs` import from `../deepgrep/src/`. In the worktree the `deepgrep/` submodule dir is present in the main checkout only — run the suite from the main repo root (as done for story 3.1).

## Open Questions (for review)

1. Is repo-map-only warming enough value to ship, given measured ~100ms build (ADR-7 flags this as possibly not worth it)? If timing on the target repos is consistently <100ms, recommend keeping the tool but documenting it as optional.
2. Should warm state have a TTL / invalidation, or is it fine to let the existing mtime-hash cache-miss path handle staleness? (Recommendation: rely on mtime hash — no separate TTL.)

---

## Decision Record (2026-06-08, post-architecture review)

**Status: wont-do** — closed without implementation.

### Why

Architecture review (Winston, baseline `0f1ed69`) ran ADR-7's gate against measured data on this repo (`fast-context-mcp`, 433 files, depth=3, default excludes):

| Operation | Cold (ms) | Cacheable by warm? |
|-----------|-----------|---------------------|
| `getRepoMap` | ~15 | ✅ yes |
| `computeMtimeHash` | ~45 | ❌ no (used as freshness check) |
| **Total** | **~60** | **net win after warm: ~15ms** |

ADR-7 condition: *"DEFER unless repo-map computation is a real bottleneck."* At ~15ms savings, sub-perceptible vs. the 3–30s API call that follows, the gate fails.

### Architectural concerns that compounded the decision

1. **Warm caches the wrong layer.** 75% of the cold cost is `computeMtimeHash`, which is a freshness primitive — caching it defeats its purpose. Warm only saves the cheap part.
2. **Option A in spec breaks `getRepoMap` purity.** Adding module-level state in `shared.mjs` is global mutation for a single consumer's benefit. Violates Rule of Three.
3. **AC6 has a silent-correctness hole.** Reusing a cached repo map after files are added/removed between `warm` and `search` would feed stale tree text to the LLM. Mtime hash protects the *result* cache but not the prompt's tree map.
4. **No verifiable user-facing improvement.** 15ms is below jitter for any integration assertion or user perception.
5. **Triggers UX friction.** Requires the user/agent to remember `warm` before `search` — replaces one friction with another.

### What would re-open this

- Real telemetry showing first-query latency complaints, OR
- An AI-agent flow measured to call `deepgrep_search` ≥3 times in <5s where mtime-hash dominates wall-clock.

In that case, the right shape is **not** `deepgrep_warm` but a **short-TTL mtime cache inside `cache.mjs`** (caches the expensive 45ms portion, no new tool, no purity break, lives in the module that already owns caching). Capture as a new story when triggered, do not pre-write a spec.

### Sprint-status implication

`3-warm-cache: wont-do`. Epic 3 has one story shipped (3.1 `deepgrep_get`) and one closed by data (3.2). Epic 3 can be marked `done` — its core value (token-efficient retrieval) is fully delivered.

