# Fast Context MCP

AI-driven semantic code search as an MCP tool — powered by Windsurf's reverse-engineered SWE-grep protocol.

Any MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.) can use this to search codebases with natural language queries. All tools are bundled via npm — **no system-level dependencies** needed (ripgrep via `@vscode/ripgrep`, tree via `tree-node-cli`). Works on macOS, Windows, and Linux.

## How It Works

```
You: "where is the authentication logic?"
         │
         ▼
┌──────────────────────────────────────────────────────┐
│  Fast Context MCP (local MCP server)                 │
│                                                      │
│  Phase 1: Bootstrap (optional)                       │
│    1. Mini-tree scan → Devstral API                  │
│    2. Returns hot directories + rg patterns          │
│                                                      │
│  Phase 2: Directory Scoring                          │
│    3. BM25F + Probe grep + Git RFM + File Agg       │
│    4. RRF fusion → adaptive topK selection           │
│       (Kneedle gap + entropy + tail threshold)       │
│    5. Path spine extraction (scored file hints)      │
│                                                      │
│  Phase 3: Main Search (N rounds)                     │
│    6. Query + optimized repo map → Devstral API      │
│       (tree + hotspot subtrees + path spines)        │
│    7. AI generates rg/readfile/tree/ls commands      │
│    8. Execute locally (built-in rg) → return results │
│    9. Repeat for N rounds                            │
│   10. Final answer: file paths + line ranges         │
│       + suggested search keywords                    │
└──────────────────────────────────────────────────────┘
         │
         ▼
Found 5 relevant files.
  [1/5] /project/src/auth/handler.py (L10-60)
  [2/5] /project/src/middleware/jwt.py (L1-40)
  [3/5] /project/src/models/user.py (L20-80)
  [4/5] /project/src/routes/login.py (L5-35)
  [5/5] /project/src/utils/token.py (L1-25)

Suggested search keywords:
  authenticate, jwt.*verify, session.*token
```

## Prerequisites

- **Node.js** >= 18
- **Windsurf account** — free tier works (needed for API key)

No need to install ripgrep — it's bundled via `@vscode/ripgrep`.

## Installation

### Option 1: npm (Recommended)

```bash
# Latest stable release
npm install @sammysnake/fast-context-mcp

# Or beta/next release
npm install @sammysnake/fast-context-mcp@next
```

### Option 2: From Source

```bash
git clone https://github.com/SammySnake-d/fast-context-mcp.git
cd fast-context-mcp
npm install
```

## Setup

### 1. Get Your Windsurf API Key

The server auto-extracts the API key from your local Windsurf installation. You can also use the `extract_windsurf_key` MCP tool after setup, or set `WINDSURF_API_KEY` manually.

Key is stored in Windsurf's local SQLite database:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Windsurf/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Windsurf/User/globalStorage/state.vscdb` |

### 2. Configure MCP Client

#### Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

For beta/next release:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp@next"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

#### Claude Desktop

Add to `claude_desktop_config.json` under `mcpServers`:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

For beta/next release:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp@next"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

> If `WINDSURF_API_KEY` is omitted, the server auto-discovers it from your local Windsurf installation.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WINDSURF_API_KEY` | *(auto-discover)* | Windsurf API key |
| `FC_MAX_TURNS` | `3` | Search rounds per query (more = deeper but slower) |
| `FC_MAX_COMMANDS` | `8` | Max parallel commands per round |
| `FC_TIMEOUT_MS` | `30000` | Connect-Timeout-Ms for streaming requests |
| `FC_REPO_MAP_MODE` | `bootstrap_hotspot` | Repo map strategy (`classic` or `bootstrap_hotspot`) |
| `FC_BOOTSTRAP_TREE_DEPTH` | `1` | Bootstrap mini-tree depth |
| `FC_HOTSPOT_TOP_K` | `4` | Base hotspot dirs (adaptive topK overrides via Kneedle + entropy) |
| `FC_HOTSPOT_TREE_DEPTH` | `2` | Tree depth for each hotspot subtree |
| `FC_HOTSPOT_MAX_BYTES` | `122880` | Max bytes budget for optimized repo map |
| `FC_BOOTSTRAP_ENABLED` | `true` | Enable standalone bootstrap phase |
| `FC_BOOTSTRAP_MAX_TURNS` | `2` | Bootstrap phase turns |
| `FC_BOOTSTRAP_MAX_COMMANDS` | `6` | Bootstrap commands per turn |
| `FC_RESULT_MAX_LINES` | `50` | Max lines per command output (truncation) |
| `FC_LINE_MAX_CHARS` | `250` | Max characters per output line (truncation) |
| `FC_PROFILE_CACHE_TTL` | `120` | Directory profile cache TTL in seconds |
| `FC_GIT_CACHE_TTL` | `300` | Git RFM analysis cache TTL in seconds |
| `WS_MODEL` | `MODEL_SWE_1_6_FAST` | Windsurf model name |
| `WS_APP_VER` | `1.48.2` | Windsurf app version (protocol metadata) |
| `WS_LS_VER` | `1.9544.35` | Windsurf language server version (protocol metadata) |

## Available Models

The model can be changed by setting `WS_MODEL` (see environment variables above).

![Available Models](docs/models.png)

Default: `MODEL_SWE_1_6_FAST` — fastest speed, richest grep keywords, finest location granularity.

## MCP Tools

### `fast_context_search`

AI-driven semantic code search with tunable parameters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language search query |
| `project_path` | string | No | cwd | Absolute path to project root |
| `tree_depth` | integer | No | `3` | Main-phase repo map depth (`0-6`, `0=auto`). Higher = more structure context but larger payload. |
| `max_turns` | integer | No | `3` | Main-phase search rounds (`1-5`). More = deeper search but slower. |
| `max_results` | integer | No | `10` | Maximum number of files to return (`1-30`). |
| `exclude_paths` | string[] | No | `[]` | Extra exclude patterns merged with built-in default excludes (`node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, ...). |
| `repo_map_mode` | enum | No | `bootstrap_hotspot` | Repo map strategy: `classic` or `bootstrap_hotspot`. |
| `bootstrap_tree_depth` | integer | No | `1` | Bootstrap phase mini-tree depth (`1-3`). |
| `hotspot_top_k` | integer | No | `4` | Base hotspot dirs (`0-8`). Adaptive topK may expand this based on score distribution. |
| `hotspot_tree_depth` | integer | No | `2` | Tree depth per hotspot subtree (`1-4`). |
| `hotspot_max_bytes` | integer | No | `122880` | Max byte budget for optimized repo map (`16384-262144`). |
| `bootstrap_enabled` | boolean | No | `true` | Enable standalone bootstrap phase before main search. |
| `bootstrap_max_turns` | integer | No | `2` | Bootstrap turns (`1-3`). Independent from `max_turns`. |
| `bootstrap_max_commands` | integer | No | `6` | Bootstrap commands per turn (`1-8`). Independent from main commands. |

Returns:
1. **Relevant files** with line ranges
2. **Suggested search keywords** (rg patterns used during AI search)
3. **Diagnostic metadata** (`[config]` line showing actual tree_depth used, tree size, and whether fallback occurred)

Example output:
```
Found 3 relevant files.

  [1/3] /project/src/auth/handler.py (L10-60, L120-180)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

grep keywords: authenticate, jwt.*verify, session.*token

[config] tree_depth=3, tree_size=12.5KB, max_turns=3
```

Error output includes status-specific hints:
```
Error: Request failed: HTTP 403

[hint] 403 Forbidden: Authentication failed. The API key may be expired or revoked.
Try re-extracting with extract_windsurf_key, or set a fresh WINDSURF_API_KEY env var.
```

```
Error: Request failed: HTTP 413

[diagnostic] tree_depth_used=3, tree_size=280.0KB (auto fell back from requested depth)
[hint] If the error is payload-related, try a lower tree_depth value.
```

### `extract_windsurf_key`

Extract Windsurf API Key from local installation. No parameters.

## Project Structure

```
fast-context-mcp/
├── package.json
├── src/
│   ├── server.mjs           # MCP server entry point
│   ├── core.mjs             # Auth, message building, streaming, search loop
│   ├── executor.mjs         # Tool executor: rg, readfile, tree, ls, glob
│   ├── directory-scorer.mjs # BM25F + Probe + Git RFM directory scoring
│   ├── extract-key.mjs      # Windsurf API Key extraction (SQLite)
│   └── protobuf.mjs         # Protobuf encoder/decoder + Connect-RPC frames
├── README.md
└── LICENSE
```

## How the Search Works

1. Project directory is mapped to virtual `/codebase` path
2. **Directory scoring** via 5-signal RRF fusion:
   - **BM25F**: multi-field scoring (dir name, file paths, metadata, headers)
   - **Probe grep**: single ripgrep call with regex alternation for content matching
   - **Bootstrap keywords**: terms from optional bootstrap pre-scan
   - **Git RFM**: Recency-Frequency-Modification model from git history
   - **File aggregation**: file-level Log-Sum scoring per directory
3. **Adaptive hotspot selection** based on IR literature:
   - **Kneedle gap detection** (Taguchi 2025 Adaptive-k): finds the largest score drop as a natural cutoff
   - **Entropy scaling** (CMU Selective Search): flat score distributions auto-expand K; peaked distributions keep K tight
   - **Adaptive tail threshold**: includes strong dirs beyond cutoff based on score decay rate (replaces fixed 0.6 ratio)
4. **Path spine extraction**: scored file paths as navigation hints, with source-code path boost and noise path penalty
5. Query + optimized repo map (tree + hotspot subtrees + path spines) sent to Windsurf Devstral via Connect-RPC/Protobuf
6. Devstral generates tool commands (ripgrep, file reads, tree, ls, glob)
7. Commands executed locally in parallel (up to `FC_MAX_COMMANDS` per round)
8. Results sent back to Devstral for the next round
9. After `max_turns` rounds, Devstral returns file paths + line ranges
10. All rg patterns used during search are collected as suggested keywords
11. Diagnostic metadata appended to help the calling AI tune parameters

### Caching

Directory profiles and Git history analysis are cached at the process level to avoid redundant filesystem walks across repeated queries:

| Cache | TTL | Configurable via |
|-------|-----|------------------|
| Directory profiles | 120s | `FC_PROFILE_CACHE_TTL` |
| Git RFM analysis | 300s | `FC_GIT_CACHE_TTL` |

Caches are scoped to the MCP server process lifetime and automatically expire. No manual invalidation needed for normal development workflows.

## Technical Details

- **Protocol**: Connect-RPC over HTTP/1.1, Protobuf encoding, gzip compression
- **Model**: Devstral (`MODEL_SWE_1_6_FAST`, configurable)
- **Local tools**: `rg` (bundled via @vscode/ripgrep), `readfile` (Node.js fs), `tree` (tree-node-cli), `ls` (Node.js fs), `glob` (Node.js fs)
- **Auth**: API Key → JWT (auto-fetched per session)
- **Runtime**: Node.js >= 18 (ESM)

### Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `@vscode/ripgrep` | Bundled ripgrep binary (cross-platform) |
| `tree-node-cli` | Cross-platform directory tree (replaces system `tree`) |
| `sql.js` | Read Windsurf's local SQLite DB (WASM, no native deps) |
| `zod` | Schema validation (MCP SDK requirement) |

## License

MIT
