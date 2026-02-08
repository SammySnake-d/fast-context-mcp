# Fast Context MCP

AI-driven semantic code search as an MCP tool — powered by Windsurf's reverse-engineered SWE-grep protocol.

Any MCP-compatible client (Claude Code, Claude Desktop, Cursor, Windsurf, etc.) can use this to search codebases with natural language queries.

## How It Works

```
You: "where is the authentication logic?"
         │
         ▼
┌─────────────────────────┐
│  Fast Context MCP       │
│  (local MCP server)     │
│                         │
│  1. Maps project → /codebase
│  2. Sends query to Windsurf API
│  3. Devstral AI generates rg/readfile/tree commands
│  4. Executes commands locally
│  5. Returns results to Devstral
│  6. Repeats for N rounds
│  7. Returns file paths + line ranges
│     + suggested search keywords
└─────────────────────────┘
         │
         ▼
Found 3 relevant files.
  [1/3] /project/src/auth/handler.py (L10-60)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

Suggested search keywords:
  authenticate, jwt.*verify, session.*token
```

## Prerequisites

- **Python** >= 3.10
- **Windsurf account** — free tier works. Needed for the API key.
- **[ripgrep](https://github.com/BurntSushi/ripgrep)** *(optional, recommended)* — faster code search. If not installed, a built-in Python fallback is used automatically.
  ```bash
  # macOS
  brew install ripgrep

  # Ubuntu/Debian
  sudo apt install ripgrep

  # Windows
  choco install ripgrep
  ```

## Installation

### Option 1: Clone and install

```bash
git clone https://github.com/SammySnake-d/fast-context-mcp.git
cd fast-context-mcp
pip install -e .
```

### Option 2: Direct use (no install)

```bash
git clone https://github.com/SammySnake-d/fast-context-mcp.git
cd fast-context-mcp
pip install mcp
```

## Setup

### 1. Get your Windsurf API Key

The API key is auto-extracted from your local Windsurf installation. You can also extract it manually:

```bash
python extract_key.py
```

Key locations by platform:
| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Windsurf/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Windsurf/User/globalStorage/state.vscdb` |

### 2. Configure MCP Client

#### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "fast-context": {
      "command": "python3",
      "args": ["/absolute/path/to/fast-context-mcp/server.py"],
      "env": {
        "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
      }
    }
  }
}
```

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fast-context": {
      "command": "python3",
      "args": ["/absolute/path/to/fast-context-mcp/server.py"],
      "env": {
        "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
      }
    }
  }
}
```

#### Using uv (recommended for dependency isolation)

```json
{
  "mcpServers": {
    "fast-context": {
      "command": "uv",
      "args": [
        "--directory", "/absolute/path/to/fast-context-mcp",
        "run", "server.py"
      ],
      "env": {
        "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
      }
    }
  }
}
```

> If `WINDSURF_API_KEY` is not set, the server auto-discovers it from your local Windsurf installation.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WINDSURF_API_KEY` | *(auto-discover)* | Windsurf API key. Auto-extracted from local Windsurf if not set. |
| `FC_MAX_TURNS` | `3` | Number of search rounds per query. More rounds = deeper search but more API usage. |
| `FC_MAX_COMMANDS` | `8` | Max parallel commands per round (rg, readfile, tree, etc.). |

Example with all options:

```json
{
  "mcpServers": {
    "fast-context": {
      "command": "python3",
      "args": ["/absolute/path/to/fast-context-mcp/server.py"],
      "env": {
        "WINDSURF_API_KEY": "sk-ws-01-xxxxx",
        "FC_MAX_TURNS": "5",
        "FC_MAX_COMMANDS": "8"
      }
    }
  }
}
```

## MCP Tools

### `fast_context_search`

AI-driven semantic code search.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `project_path` | string | No | Absolute path to project root (default: working directory) |

**Output** contains two sections:

1. **Relevant files** — file paths with line ranges to examine
2. **Suggested search keywords** — rg patterns used during AI search, useful for further exploration

Example output:
```
Found 3 relevant files. IMPORTANT: You MUST examine ALL 3 files below to fully understand the context.

  [1/3] /project/src/auth/handler.py (L10-60, L120-180)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

Suggested search keywords (rg patterns used during AI search). Use these with grep/rg to discover additional relevant files:
  authenticate, jwt.*verify, session.*token, middleware.*auth
```

### `extract_windsurf_key`

Extract Windsurf API Key from local installation. No parameters.

## How the Search Works

1. Project directory is mapped to virtual `/codebase` path
2. Query + directory tree sent to Windsurf's Devstral model via Connect-RPC
3. Devstral generates tool commands (ripgrep searches, file reads, directory trees)
4. Commands are executed locally in parallel (up to `FC_MAX_COMMANDS` per round)
5. Results are sent back to Devstral for the next round
6. After `FC_MAX_TURNS` rounds, Devstral returns the final answer as file paths + line ranges
7. All rg patterns used by Devstral during search are collected and returned as suggested keywords

## Project Structure

```
fast-context-mcp/
├── server.py          # MCP server entry point
├── core.py            # Core protocol implementation
├── extract_key.py     # API key extraction utility
├── pyproject.toml     # Package configuration
└── README.md
```

## Technical Details

- **Protocol**: Connect-RPC over HTTP/1.1, Protobuf encoding, gzip compression
- **Model**: Devstral (`MODEL_SWE_1_5_SLOW`)
- **Local tools**: `rg`, `readfile`, `tree`, `ls`, `glob`
- **Auth**: API Key → JWT (auto-fetched per session)
- **Endpoint**: `server.self-serve.windsurf.com`

## License

MIT
