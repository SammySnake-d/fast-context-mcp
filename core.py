"""
Windsurf Fast Context — core protocol implementation.

Reverse-engineered Windsurf SWE-grep Connect-RPC/Protobuf protocol
for standalone AI-driven semantic code search.

Flow:
  query + tree → Windsurf Devstral API
  → Devstral returns tool_calls (rg/readfile/tree/ls/glob, up to 8 parallel)
  → execute locally → send results back → repeat for N rounds
  → ANSWER: file paths + line ranges + suggested rg patterns
"""

from __future__ import annotations

import gzip
import json
import multiprocessing
import os
import platform
import re
import sqlite3
import struct
import subprocess
import ssl
import sys
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.error import HTTPError
from urllib.request import Request, urlopen


# ─── SSL ────────────────────────────────────────────────────

def _ssl_ctx() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    try:
        ctx = ssl.create_default_context()
        ctx.load_default_certs()
        return ctx
    except Exception:
        pass
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

_SSL_CTX = _ssl_ctx()


# ─── Protobuf Encoder ──────────────────────────────────────

class ProtobufEncoder:
    """手动 protobuf 编码器，完全匹配 Windsurf 的请求格式。"""

    def __init__(self) -> None:
        self.buf = bytearray()

    def _varint(self, value: int) -> bytes:
        parts: list[int] = []
        while value > 0x7F:
            parts.append((value & 0x7F) | 0x80)
            value >>= 7
        parts.append(value & 0x7F)
        return bytes(parts)

    def _tag(self, field: int, wire: int) -> bytes:
        return self._varint((field << 3) | wire)

    def write_varint(self, field: int, value: int) -> ProtobufEncoder:
        self.buf.extend(self._tag(field, 0))
        self.buf.extend(self._varint(value))
        return self

    def write_string(self, field: int, value: str) -> ProtobufEncoder:
        data = value.encode("utf-8")
        self.buf.extend(self._tag(field, 2))
        self.buf.extend(self._varint(len(data)))
        self.buf.extend(data)
        return self

    def write_bytes(self, field: int, value: bytes) -> ProtobufEncoder:
        self.buf.extend(self._tag(field, 2))
        self.buf.extend(self._varint(len(value)))
        self.buf.extend(value)
        return self

    def write_message(self, field: int, sub: ProtobufEncoder) -> ProtobufEncoder:
        data = bytes(sub.buf)
        self.buf.extend(self._tag(field, 2))
        self.buf.extend(self._varint(len(data)))
        self.buf.extend(data)
        return self

    def to_bytes(self) -> bytes:
        return bytes(self.buf)


# ─── Connect-RPC 帧编解码 ──────────────────────────────────

def connect_frame_encode(proto_bytes: bytes) -> bytes:
    compressed = gzip.compress(proto_bytes)
    return struct.pack("B", 1) + struct.pack(">I", len(compressed)) + compressed


def connect_frames_decode(data: bytes) -> List[bytes]:
    frames: list[bytes] = []
    i = 0
    while i + 5 <= len(data):
        flags = data[i]
        length = struct.unpack(">I", data[i + 1 : i + 5])[0]
        i += 5
        payload = data[i : i + length]
        i += length
        if flags in (1, 3):
            try:
                payload = gzip.decompress(payload)
            except Exception:
                pass
        frames.append(payload)
    return frames


# ─── Protobuf 解码 ─────────────────────────────────────────

def proto_extract_strings(data: bytes) -> List[str]:
    strings: list[str] = []
    i = 0
    while i < len(data):
        tag = 0
        shift = 0
        while i < len(data):
            b = data[i]; i += 1
            tag |= (b & 0x7F) << shift; shift += 7
            if not (b & 0x80):
                break
        wire = tag & 0x7
        if wire == 0:
            while i < len(data):
                b = data[i]; i += 1
                if not (b & 0x80):
                    break
        elif wire == 1:
            i += 8
        elif wire == 2:
            length = 0; shift = 0
            while i < len(data):
                b = data[i]; i += 1
                length |= (b & 0x7F) << shift; shift += 7
                if not (b & 0x80):
                    break
            if i + length <= len(data):
                raw = data[i : i + length]
                try:
                    text = raw.decode("utf-8")
                    if len(text) > 5:
                        strings.append(text)
                except UnicodeDecodeError:
                    pass
            i += length
        elif wire == 5:
            i += 4
        else:
            break
    return strings


# ─── 本地工具执行器 ────────────────────────────────────────

RESULT_MAX_LINES = 50
LINE_MAX_CHARS = 250


class ToolExecutor:
    """在本地项目目录执行 SWE-grep 的受限工具命令。"""

    def __init__(self, project_root: str) -> None:
        self.root = os.path.abspath(project_root)
        self.collected_rg_patterns: List[str] = []

    def _real(self, virtual: str) -> str:
        if virtual.startswith("/codebase"):
            rel = virtual[len("/codebase") :].lstrip("/")
            return os.path.join(self.root, rel)
        return virtual

    @staticmethod
    def _truncate(text: str) -> str:
        lines = text.split("\n")
        # Match original Windsurf behavior: 50 line limit + ~250 char per-line silent truncation
        truncated_lines = []
        for line in lines[:RESULT_MAX_LINES]:
            if len(line) > LINE_MAX_CHARS:
                truncated_lines.append(line[:LINE_MAX_CHARS])
            else:
                truncated_lines.append(line)
        text = "\n".join(truncated_lines)
        if len(lines) > RESULT_MAX_LINES:
            text += "\n... (lines truncated) ..."
        return text

    def _remap(self, text: str) -> str:
        return text.replace(self.root, "/codebase")

    _rg_bin: str | None = None
    _rg_checked: bool = False

    @classmethod
    def _find_rg(cls) -> str | None:
        """Find rg binary. Returns path or None. Result is cached."""
        if cls._rg_checked:
            return cls._rg_bin
        cls._rg_checked = True
        for candidate in ["rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg"]:
            try:
                subprocess.run([candidate, "--version"], capture_output=True, timeout=5)
                cls._rg_bin = candidate
                return candidate
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        cls._rg_bin = None
        return None

    @staticmethod
    def _glob_match(rel_path: str, filename: str, patterns: list[str]) -> bool:
        """Check if a file matches any glob pattern."""
        import fnmatch
        for pat in patterns:
            normalized = pat.replace("\\", "/")
            # **/*.ext → match by filename
            if normalized.startswith("**/"):
                sub = normalized[3:]
                if "/**" in sub:
                    # **/dirname/** → handled by skip_dirs
                    continue
                if fnmatch.fnmatch(filename, sub):
                    return True
            elif fnmatch.fnmatch(rel_path, normalized):
                return True
            elif fnmatch.fnmatch(filename, normalized):
                return True
        return False

    def _rg_python(self, pattern: str, real_path: str, virtual_path: str,
                   include: list[str] | None, exclude: list[str] | None) -> str:
        """Pure Python ripgrep replacement — zero external dependencies."""
        try:
            regex = re.compile(pattern)
        except re.error:
            regex = re.compile(re.escape(pattern))

        results: list[str] = []
        skip_dirs = {
            ".git", "node_modules", "__pycache__", ".venv", "venv",
            "dist", "build", ".cache", "target", ".tox", ".eggs",
            ".mypy_cache", "coverage", "out",
        }
        # Add directory-based exclude patterns
        if exclude:
            for pat in exclude:
                normalized = pat.lstrip("!").replace("\\", "/")
                if normalized.startswith("**/") and normalized.endswith("/**"):
                    skip_dirs.add(normalized[3:-3])

        if os.path.isfile(real_path):
            matches = self._rg_search_file(regex, real_path, RESULT_MAX_LINES)
            for lineno, line in matches:
                results.append(f"{virtual_path}:{lineno}:{line}")
        else:
            for root, dirs, files in os.walk(real_path):
                dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
                for fname in sorted(files):
                    fpath = os.path.join(root, fname)
                    rel = os.path.relpath(fpath, real_path)
                    if include and not self._glob_match(rel, fname, include):
                        continue
                    if exclude and self._glob_match(
                        rel, fname, [p.lstrip("!") for p in exclude]
                    ):
                        continue
                    matches = self._rg_search_file(regex, fpath, RESULT_MAX_LINES)
                    vpath = virtual_path.rstrip("/") + "/" + rel.replace(os.sep, "/")
                    for lineno, line in matches:
                        results.append(f"{vpath}:{lineno}:{line}")
                    if len(results) >= RESULT_MAX_LINES:
                        break
                if len(results) >= RESULT_MAX_LINES:
                    break

        output = "\n".join(results) if results else "(no matches)"
        return self._truncate(self._remap(output))

    @staticmethod
    def _rg_search_file(regex, filepath: str, max_matches: int) -> list[tuple[int, str]]:
        """Search a single file for regex matches."""
        try:
            with open(filepath, "rb") as f:
                head = f.read(512)
                if b"\x00" in head:
                    return []
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                matches = []
                for lineno, line in enumerate(f, 1):
                    if regex.search(line):
                        matches.append((lineno, line.rstrip("\n\r")))
                        if len(matches) >= max_matches:
                            break
                return matches
        except (OSError, PermissionError):
            return []

    def rg(self, pattern: str, path: str,
           include: list[str] | None = None,
           exclude: list[str] | None = None) -> str:
        self.collected_rg_patterns.append(pattern)
        rp = self._real(path)
        if not os.path.exists(rp):
            return f"Error: path does not exist: {path}"
        rg_bin = self._find_rg()
        if rg_bin is None:
            return self._rg_python(pattern, rp, path, include, exclude)
        cmd = [rg_bin, "--no-heading", "-n", "--max-count", "50", pattern, rp]
        if include:
            for g in include:
                cmd += ["--glob", g]
        if exclude:
            for g in exclude:
                cmd += ["--glob", f"!{g}"]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=30,
                               env={**os.environ, "RIPGREP_CONFIG_PATH": ""})
            out = r.stdout.decode("utf-8", errors="replace") if r.stdout else ""
            err = r.stderr.decode("utf-8", errors="replace") if r.stderr else ""
            return self._truncate(self._remap(out or err or "(no matches)"))
        except FileNotFoundError:
            return self._rg_python(pattern, rp, path, include, exclude)
        except subprocess.TimeoutExpired:
            return "Error: timed out"

    def readfile(self, file: str,
                 start_line: int | None = None,
                 end_line: int | None = None) -> str:
        rp = self._real(file)
        if not os.path.isfile(rp):
            return f"Error: file not found: {file}"
        try:
            with open(rp, "r", encoding="utf-8", errors="replace") as f:
                all_lines = f.readlines()
        except Exception as e:
            return f"Error: {e}"
        s = (start_line or 1) - 1
        e = end_line or len(all_lines)
        selected = all_lines[s:e]
        out = "".join(f"{i}:{line}" for i, line in enumerate(selected, start=s + 1))
        return self._truncate(out)

    def tree(self, path: str, levels: int | None = None) -> str:
        rp = self._real(path)
        if not os.path.isdir(rp):
            return f"Error: dir not found: {path}"
        cmd = ["tree", rp]
        if levels:
            cmd += ["-L", str(levels)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            return self._truncate(self._remap(r.stdout or r.stderr))
        except FileNotFoundError:
            return self._tree_py(rp, levels or 3, path)
        except subprocess.TimeoutExpired:
            return "Error: timed out"

    def _tree_py(self, real: str, levels: int, virt: str) -> str:
        lines = [virt]
        def walk(p: str, pfx: str, d: int) -> None:
            if d >= levels:
                return
            try:
                entries = sorted(os.listdir(p))
            except PermissionError:
                return
            for e in entries:
                fp = os.path.join(p, e)
                lines.append(f"{pfx}├── {e}")
                if os.path.isdir(fp) and not e.startswith("."):
                    walk(fp, pfx + "│   ", d + 1)
        walk(real, "", 0)
        return "\n".join(lines[:300])

    def ls(self, path: str, long_format: bool = False, all_files: bool = False) -> str:
        rp = self._real(path)
        cmd = ["ls"]
        if long_format:
            cmd.append("-l")
        if all_files:
            cmd.append("-a")
        cmd.append(rp)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            return self._truncate(self._remap(r.stdout or r.stderr))
        except Exception as e:
            return f"Error: {e}"

    def glob_cmd(self, pattern: str, path: str, type_filter: str = "all") -> str:
        import glob as gmod
        rp = self._real(path)
        matches = gmod.glob(os.path.join(rp, pattern), recursive=True)
        if type_filter == "file":
            matches = [m for m in matches if os.path.isfile(m)]
        elif type_filter == "directory":
            matches = [m for m in matches if os.path.isdir(m)]
        out = "\n".join(self._remap(m) for m in sorted(matches)[:100])
        return out or "(no matches)"

    def exec_command(self, cmd: Dict[str, Any]) -> str:
        t = cmd.get("type", "")
        if t == "rg":
            return self.rg(cmd["pattern"], cmd["path"], cmd.get("include"), cmd.get("exclude"))
        if t == "readfile":
            return self.readfile(cmd["file"], cmd.get("start_line"), cmd.get("end_line"))
        if t == "tree":
            return self.tree(cmd["path"], cmd.get("levels"))
        if t == "ls":
            return self.ls(cmd["path"], cmd.get("long_format", False), cmd.get("all", False))
        if t == "glob":
            return self.glob_cmd(cmd["pattern"], cmd["path"], cmd.get("type_filter", "all"))
        return f"Error: unknown command type '{t}'"

    def exec_tool_call(self, args: Dict[str, Any]) -> str:
        parts: list[str] = []
        for key in sorted(args.keys()):
            if key.startswith("command") and isinstance(args[key], dict):
                output = self.exec_command(args[key])
                parts.append(f"<{key}_result>\n{output}\n</{key}_result>")
        return "".join(parts)


# ─── 协议常量 ──────────────────────────────────────────────

API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService"
AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService"
WS_APP = "windsurf"
WS_APP_VER = "1.48.2"
WS_LS_VER = "1.9544.35"
WS_MODEL = "MODEL_SWE_1_5_SLOW"

# 系统提示模板（{max_turns} 和 {max_commands} 由调用者填入）
SYSTEM_PROMPT_TEMPLATE = (
    "You are an expert software engineer, responsible for providing context "
    "to another engineer to solve a code issue in the current codebase. "
    "The user will present you with a description of the issue, and it is "
    "your job to provide a series of file paths with associated line ranges "
    "that contain ALL the information relevant to understand and correctly "
    "address the issue.\n\n"
    "# IMPORTANT:\n"
    "- A relevant file does not mean only the files that must be modified to "
    "solve the task. It means any file that contains information relevant to "
    "planning and implementing the fix, such as the definitions of classes "
    "and functions that are relevant to the pieces of code that will have to "
    "be modified.\n"
    "- You should include enough context around the relevant lines to allow "
    "the engineer to understand the task correctly. You must include ENTIRE "
    "semantic blocks (functions, classes, definitions, etc). For example:\n"
    "If addressing the issue requires modifying a method within a class, then "
    "you should include the entire class definition, not just the lines around "
    "the method we want to modify.\n"
    "- NEVER truncate these blocks unless they are very large (hundreds of "
    "lines or more, in which case providing only a relevant portion of the "
    "block is acceptable).\n"
    "- Your job is to essentially alleviate the job of the other engineer by "
    "giving them a clean starting context from which to start working. More "
    "precisely, you should minimize the number of files the engineer has to "
    "read to understand and solve the task correctly (while not providing "
    "irrelevant code snippets).\n\n"
    "# ENVIRONMENT\n"
    "- Working directory: /codebase. Make sure to run commands in this "
    "directory, not `.`.\n"
    "- Tool access: use the restricted_exec tool ONLY\n"
    "- Allowed sub-commands (schema-enforced):\n"
    "  - rg: Search for patterns in files using ripgrep\n"
    "    - Required: pattern (string), path (string)\n"
    "    - Optional: include (array of globs), exclude (array of globs)\n"
    "  - readfile: Read contents of a file with optional line range\n"
    "    - Required: file (string)\n"
    "    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive\n"
    "  - tree: Display directory structure as a tree\n"
    "    - Required: path (string)\n"
    "    - Optional: levels (int)\n"
    "  - ls: List files in a directory\n"
    "    - Required: path (string)\n"
    "    - Optional: long_format (bool), all (bool)\n"
    "  - glob: Find files matching a glob pattern\n"
    "    - Required: pattern (string), path (string)\n"
    "    - Optional: type_filter (string: file/directory/all)\n\n"
    "# THINKING RULES\n"
    "- Think step-by-step. Plan, reason, and reflect before each tool call.\n"
    "- Use tool calls liberally and purposefully to ground every conclusion "
    "in real code, not assumptions.\n"
    "- If a command fails, rethink and try something different; do not "
    "complain to the user.\n\n"
    "# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)\n"
    "- Start NARROW, then widen only if needed. Prefer searching likely code "
    "roots first (e.g., `src/`, `lib/`, `app/`, `packages/`, `services/`) "
    "instead of `/codebase`.\n"
    "- Prefer fixed-string search for literals: escape patterns or keep regex "
    "simple. Use smart case; avoid case-insensitive unless necessary.\n"
    "- Prefer file-type filters and globs (in include) over full-repo scans.\n"
    "- Default EXCLUDES for speed (apply via the exclude array): "
    "node_modules, .git, dist, build, coverage, .venv, venv, target, out, "
    ".cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*\n"
    "- Skip huge files where possible; when opening files, prefer reading "
    "only relevant ranges with readfile.\n"
    "- Limit directory traversal with tree levels to quickly orient before "
    "deeper inspection.\n\n"
    "# SOME EXAMPLES OF WORKFLOWS\n"
    "- MAP – Use `tree` with small levels; `rg` on likely roots to grasp "
    "structure and hotspots.\n"
    "- ANCHOR – `rg` for problem keywords and anchor symbols; restrict by "
    "language globs via include.\n"
    "- TRACE – Follow imports with targeted `rg` in narrowed roots; open "
    "files with `readfile` scoped to entire semantic blocks.\n"
    "- VERIFY – Confirm each candidate path exists by reading or additional "
    "searches; drop false positives (tests, vendored, generated) unless they "
    "must change.\n\n"
    "# TOOL USE GUIDELINES\n"
    "- You must use a SINGLE restricted_exec call in your answer, that lets "
    "you execute at most {max_commands} commands in a single turn. Each command must be "
    "an object with a `type` field of `rg`, `readfile`, `tree`, `ls`, or "
    "`glob` and the appropriate fields for that type.\n"
    "- Example restricted_exec usage:\n"
    '[TOOL_CALLS]restricted_exec[ARGS]{{\n'
    '  "command1": {{\n'
    '    "type": "rg",\n'
    '    "pattern": "Controller",\n'
    '    "path": "/codebase/slime",\n'
    '    "include": ["**/*.py"],\n'
    '    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", '
    '"**/build/**", "**/.venv/**", "**/__pycache__/**"]\n'
    "  }},\n"
    '  "command2": {{\n'
    '    "type": "readfile",\n'
    '    "file": "/codebase/slime/train.py",\n'
    '    "start_line": 1,\n'
    '    "end_line": 200\n'
    "  }},\n"
    '  "command3": {{\n'
    '    "type": "tree",\n'
    '    "path": "/codebase/slime/",\n'
    '    "levels": 2\n'
    "  }}\n"
    "}}\n"
    "- You have at most {max_turns} turns to interact with the environment by calling "
    "tools, so issuing multiple commands at once is necessary and encouraged "
    "to speed up your research.\n"
    "- Each command result may be truncated to 50 lines; prefer multiple "
    "targeted reads/searches to build complete context.\n"
    "- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will "
    "be penalized.\n\n"
    "# ANSWER FORMAT (strict format, including tags)\n"
    '- You will output an XML structure with a root element "ANSWER" '
    'containing "file" elements. Each "file" element will have a "path" '
    'attribute and contain "range" elements.\n'
    "- You will output this as your final response.\n"
    "- The line ranges must be inclusive.\n\n"
    'Output example inside the "answer" tool argument:\n'
    "<ANSWER>\n"
    '  <file path="/codebase/info_theory/formulas/entropy.py">\n'
    "    <range>10-60</range>\n"
    "    <range>150-210</range>\n"
    "  </file>\n"
    '  <file path="/codebase/info_theory/data_structures/bits.py">\n'
    "    <range>1-40</range>\n"
    "    <range>110-170</range>\n"
    "  </file>\n"
    "</ANSWER>\n\n\n"
    "Remember: Prefer narrow, fixed-string, and type-filtered searches with "
    "aggressive excludes and size/depth limits. Widen scope only as needed. "
    "Use the restricted tools available to you, and output your answer in "
    "exactly the specified format.\n"
)

FINAL_FORCE_ANSWER = (
    "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete."
)


def build_system_prompt(max_turns: int = 3, max_commands: int = 8) -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(max_turns=max_turns, max_commands=max_commands)


def _build_command_schema(n: int) -> dict:
    return {
        "type": "object",
        "description": f"Command {n} to execute. Must be one of: rg, readfile, or tree.",
        "oneOf": [
            {
                "properties": {
                    "type": {"type": "string", "const": "rg",
                             "description": "Search for patterns in files using ripgrep."},
                    "pattern": {"type": "string", "description": "The regex pattern to search for."},
                    "path": {"type": "string", "description": "The path to search in."},
                    "include": {"type": "array", "items": {"type": "string"},
                                "description": "File patterns to include."},
                    "exclude": {"type": "array", "items": {"type": "string"},
                                "description": "File patterns to exclude."},
                },
                "required": ["type", "pattern", "path"],
            },
            {
                "properties": {
                    "type": {"type": "string", "const": "readfile",
                             "description": "Read contents of a file with optional line range."},
                    "file": {"type": "string", "description": "Path to the file to read."},
                    "start_line": {"type": "integer", "description": "Starting line number (1-indexed)."},
                    "end_line": {"type": "integer", "description": "Ending line number (1-indexed)."},
                },
                "required": ["type", "file"],
            },
            {
                "properties": {
                    "type": {"type": "string", "const": "tree",
                             "description": "Display directory structure as a tree."},
                    "path": {"type": "string", "description": "Path to the directory."},
                    "levels": {"type": "integer", "description": "Number of directory levels."},
                },
                "required": ["type", "path"],
            },
            {
                "properties": {
                    "type": {"type": "string", "const": "ls",
                             "description": "List files in a directory."},
                    "path": {"type": "string", "description": "Path to the directory."},
                    "long_format": {"type": "boolean"},
                    "all": {"type": "boolean"},
                },
                "required": ["type", "path"],
            },
            {
                "properties": {
                    "type": {"type": "string", "const": "glob",
                             "description": "Find files matching a glob pattern."},
                    "pattern": {"type": "string"},
                    "path": {"type": "string"},
                    "type_filter": {"type": "string", "enum": ["file", "directory", "all"]},
                },
                "required": ["type", "pattern", "path"],
            },
        ],
    }


def get_tool_definitions(max_commands: int = 8) -> str:
    props = {f"command{i}": _build_command_schema(i) for i in range(1, max_commands + 1)}
    tools = [
        {
            "type": "function",
            "function": {
                "name": "restricted_exec",
                "description": "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
                "parameters": {"type": "object", "properties": props, "required": ["command1"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "answer",
                "description": "Final answer with relevant files and line ranges.",
                "parameters": {
                    "type": "object",
                    "properties": {"answer": {"type": "string", "description": "The final answer in XML format."}},
                    "required": ["answer"],
                },
            },
        },
    ]
    return json.dumps(tools, ensure_ascii=False)


# ─── 凭证 ──────────────────────────────────────────────────

def auto_discover_api_key() -> Optional[str]:
    """从 Windsurf 本地安装中提取 API key（Mac + Windows）。"""
    if sys.platform == "darwin":
        db_path = Path.home() / "Library" / "Application Support" / "Windsurf" / "User" / "globalStorage" / "state.vscdb"
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        db_path = Path(appdata) / "Windsurf" / "User" / "globalStorage" / "state.vscdb"
    else:
        # Linux: try XDG
        config = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
        db_path = Path(config) / "Windsurf" / "User" / "globalStorage" / "state.vscdb"

    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").fetchone()
        conn.close()
        if row:
            data = json.loads(row[0])
            api_key = data.get("apiKey", "")
            if api_key.startswith("sk-"):
                return api_key
    except Exception:
        pass
    return None


def get_api_key() -> str:
    """获取 API key：环境变量 > 自动发现。"""
    key = os.environ.get("WINDSURF_API_KEY")
    if key:
        return key
    key = auto_discover_api_key()
    if key:
        return key
    raise RuntimeError(
        "未找到 Windsurf API Key。请设置环境变量 WINDSURF_API_KEY "
        "或确保 Windsurf 已登录。运行 extract_key.py 查看提取方法。"
    )


# ─── 网络层 ────────────────────────────────────────────────

def _unary_request(url: str, proto_bytes: bytes, compress: bool = True) -> bytes:
    headers = {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        "User-Agent": f"connect-go/1.18.1 (go1.25.5)",
        "Accept-Encoding": "gzip",
    }
    if compress:
        body = gzip.compress(proto_bytes)
        headers["Content-Encoding"] = "gzip"
    else:
        body = proto_bytes
    req = Request(url, data=body, headers=headers, method="POST")
    with urlopen(req, timeout=30, context=_SSL_CTX) as resp:
        data = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data


def _streaming_request(proto_bytes: bytes, timeout_ms: int = 5999) -> bytes:
    frame = connect_frame_encode(proto_bytes)
    url = f"{API_BASE}/GetDevstralStream"
    trace_id = uuid.uuid4().hex
    span_id = uuid.uuid4().hex[:16]
    headers = {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Connect-Accept-Encoding": "gzip",
        "Connect-Content-Encoding": "gzip",
        "Connect-Timeout-Ms": str(timeout_ms),
        "User-Agent": f"connect-go/1.18.1 (go1.25.5)",
        "Accept-Encoding": "identity",
        "Baggage": (
            f"sentry-release=language-server-windsurf@{WS_LS_VER},"
            f"sentry-environment=stable,sentry-sampled=false,"
            f"sentry-trace_id={trace_id},"
            "sentry-public_key=b813f73488da69eedec534dba1029111"
        ),
        "Sentry-Trace": f"{trace_id}-{span_id}-0",
    }
    req = Request(url, data=frame, headers=headers, method="POST")
    with urlopen(req, timeout=120, context=_SSL_CTX) as resp:
        return resp.read()


def fetch_jwt(api_key: str) -> str:
    meta = ProtobufEncoder()
    meta.write_string(1, WS_APP)
    meta.write_string(2, WS_APP_VER)
    meta.write_string(3, api_key)
    meta.write_string(4, "zh-cn")
    meta.write_string(7, WS_LS_VER)
    meta.write_string(12, WS_APP)
    meta.write_bytes(30, b"\x00\x01")
    outer = ProtobufEncoder()
    outer.write_message(1, meta)
    resp = _unary_request(f"{AUTH_BASE}/GetUserJwt", outer.to_bytes(), compress=False)
    for s in proto_extract_strings(resp):
        if s.startswith("eyJ") and "." in s:
            return s
    raise RuntimeError("无法从 GetUserJwt 响应中提取 JWT")


def check_rate_limit(api_key: str, jwt: str) -> bool:
    req = ProtobufEncoder()
    req.write_message(1, _build_metadata(api_key, jwt))
    req.write_string(3, WS_MODEL)
    try:
        _unary_request(f"{API_BASE}/CheckUserMessageRateLimit", req.to_bytes(), compress=True)
        return True
    except HTTPError as e:
        if e.code == 429:
            return False
        raise
    except Exception:
        return True  # 网络问题时不阻塞


# ─── 请求构建 ──────────────────────────────────────────────

def _build_metadata(api_key: str, jwt: str) -> ProtobufEncoder:
    meta = ProtobufEncoder()
    meta.write_string(1, WS_APP)
    meta.write_string(2, WS_APP_VER)
    meta.write_string(3, api_key)
    meta.write_string(4, "zh-cn")
    sys_info = {
        "Os": platform.system().lower(),
        "Arch": platform.machine(),
        "Release": platform.release(),
        "Version": platform.version(),
        "Machine": platform.machine(),
        "Nodename": platform.node(),
        "Sysname": platform.system(),
        "ProductVersion": platform.mac_ver()[0] if sys.platform == "darwin" else "",
    }
    meta.write_string(5, json.dumps(sys_info))
    meta.write_string(7, WS_LS_VER)
    try:
        ncpu = multiprocessing.cpu_count()
    except Exception:
        ncpu = 4
    try:
        mem = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, AttributeError, OSError):
        mem = 0
    cpu_info = {
        "NumSockets": 1, "NumCores": ncpu, "NumThreads": ncpu,
        "VendorID": "", "Family": "0", "Model": "0",
        "ModelName": platform.processor() or "Unknown", "Memory": mem,
    }
    meta.write_string(8, json.dumps(cpu_info))
    meta.write_string(12, WS_APP)
    meta.write_string(21, jwt)
    meta.write_bytes(30, b"\x00\x01")
    return meta


def _build_chat_message(role: int, content: str, *,
                        tool_call_id: str | None = None,
                        tool_name: str | None = None,
                        tool_args_json: str | None = None,
                        ref_call_id: str | None = None) -> ProtobufEncoder:
    msg = ProtobufEncoder()
    msg.write_varint(2, role)
    msg.write_string(3, content)
    if tool_call_id and tool_name and tool_args_json:
        tc = ProtobufEncoder()
        tc.write_string(1, tool_call_id)
        tc.write_string(2, tool_name)
        tc.write_string(3, tool_args_json)
        msg.write_message(6, tc)
    if ref_call_id:
        msg.write_string(7, ref_call_id)
    return msg


def _build_request(api_key: str, jwt: str, messages: list[dict], tool_defs: str) -> bytes:
    req = ProtobufEncoder()
    req.write_message(1, _build_metadata(api_key, jwt))
    for m in messages:
        msg_enc = _build_chat_message(
            role=m["role"], content=m["content"],
            tool_call_id=m.get("tool_call_id"),
            tool_name=m.get("tool_name"),
            tool_args_json=m.get("tool_args_json"),
            ref_call_id=m.get("ref_call_id"),
        )
        req.write_message(2, msg_enc)
    req.write_string(3, tool_defs)
    return req.to_bytes()


# ─── 响应解析 ──────────────────────────────────────────────

def _parse_tool_call(text: str) -> Optional[Tuple[str, str, Dict]]:
    text = text.replace("</s>", "")
    m = re.search(r"\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)", text, re.DOTALL)
    if not m:
        return None
    name = m.group(1)
    raw = m.group(2).strip()
    depth = 0
    end = 0
    for i, ch in enumerate(raw):
        if ch == "{": depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end == 0:
        end = len(raw)
    try:
        args = json.loads(raw[:end])
    except json.JSONDecodeError:
        return None
    thinking = text[: m.start()].strip()
    return thinking, name, args


def _parse_response(data: bytes) -> Tuple[str, Optional[Tuple[str, Dict]]]:
    frames = connect_frames_decode(data)
    all_text = ""
    for frame_data in frames:
        try:
            text_candidate = frame_data.decode("utf-8")
            if text_candidate.startswith("{"):
                err_obj = json.loads(text_candidate)
                if "error" in err_obj:
                    code = err_obj["error"].get("code", "unknown")
                    msg = err_obj["error"].get("message", "")
                    return f"[Error] {code}: {msg}", None
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            pass
        # 直接从帧数据提取文本（绕过 protobuf 嵌套问题）
        raw_text = frame_data.decode("utf-8", errors="ignore")
        if "[TOOL_CALLS]" in raw_text:
            all_text = raw_text
            break
        for s in proto_extract_strings(frame_data):
            if len(s) > 10:
                all_text += s

    parsed = _parse_tool_call(all_text)
    if parsed:
        thinking, name, args = parsed
        return thinking, (name, args)
    return all_text, None


# ─── 核心搜索 ──────────────────────────────────────────────

def get_repo_map(project_root: str) -> str:
    try:
        r = subprocess.run(["tree", "-L", "1", project_root],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.replace(project_root, "/codebase")
    except FileNotFoundError:
        entries = sorted(os.listdir(project_root))
        return "\n".join(["/codebase"] + [f"├── {e}" for e in entries])


def search(
    query: str,
    project_root: str,
    api_key: str | None = None,
    jwt: str | None = None,
    max_turns: int = 3,
    max_commands: int = 8,
    on_progress: Callable[[str], None] | None = None,
) -> Dict[str, Any]:
    """
    执行 Fast Context 搜索。

    Args:
        query: 自然语言搜索查询
        project_root: 项目根目录
        api_key: Windsurf API key（不传则自动获取）
        jwt: JWT token（不传则自动获取）
        max_turns: 搜索轮数（默认 3，与 Windsurf 原版一致）
        max_commands: 每轮最大命令数（默认 8）
        on_progress: 进度回调

    Returns:
        {"files": [...], "error": "..."} 或 {"files": [...]}
    """
    def log(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    project_root = os.path.abspath(project_root)

    # 获取凭证
    if not api_key:
        api_key = get_api_key()
    if not jwt:
        log("获取 JWT...")
        jwt = fetch_jwt(api_key)

    # 检查限流
    log("检查限流...")
    if not check_rate_limit(api_key, jwt):
        return {"files": [], "error": "触发限流，请稍后再试"}

    executor = ToolExecutor(project_root)
    tool_defs = get_tool_definitions(max_commands)
    system_prompt = build_system_prompt(max_turns, max_commands)

    repo_map = get_repo_map(project_root)
    user_content = f"Problem Statement: {query}\n\nRepo Map (tree -L 1 /codebase):\n```text\n{repo_map}\n```"

    messages: list[dict] = [
        {"role": 5, "content": system_prompt},
        {"role": 1, "content": user_content},
    ]

    # 总 API 调用 = max_turns + 1（最后一轮 answer）
    total_api_calls = max_turns + 1

    for turn in range(total_api_calls):
        log(f"轮次 {turn + 1}/{total_api_calls}")

        proto = _build_request(api_key, jwt, messages, tool_defs)
        try:
            resp_data = _streaming_request(proto)
        except Exception as e:
            return {"files": [], "error": f"请求失败: {e}"}

        thinking, tool_info = _parse_response(resp_data)

        if tool_info is None:
            if thinking.startswith("[Error]"):
                return {"files": [], "error": thinking}
            return {"files": [], "raw_response": thinking}

        tool_name, tool_args = tool_info

        if tool_name == "answer":
            answer_xml = tool_args.get("answer", "")
            log("收到最终答案")
            result = _parse_answer(answer_xml, project_root)
            result["rg_patterns"] = list(dict.fromkeys(executor.collected_rg_patterns))
            return result

        if tool_name == "restricted_exec":
            call_id = str(uuid.uuid4())
            args_json = json.dumps(tool_args, ensure_ascii=False)

            cmds = [k for k in tool_args if k.startswith("command")]
            log(f"执行 {len(cmds)} 个本地命令")

            results = executor.exec_tool_call(tool_args)

            messages.append({
                "role": 2, "content": thinking,
                "tool_call_id": call_id, "tool_name": "restricted_exec",
                "tool_args_json": args_json,
            })
            messages.append({"role": 4, "content": results, "ref_call_id": call_id})

            # 最后一轮搜索后注入强制回答
            if turn >= max_turns - 1:
                messages.append({"role": 1, "content": FINAL_FORCE_ANSWER})
                log("注入强制回答提示")

    return {"files": [], "error": "达到最大轮次仍未获得答案",
            "rg_patterns": list(dict.fromkeys(executor.collected_rg_patterns))}


def _parse_answer(xml_text: str, project_root: str) -> Dict[str, Any]:
    files = []
    for fm in re.finditer(r'<file\s+path="([^"]+)">(.*?)</file>', xml_text, re.DOTALL):
        vpath = fm.group(1)
        rel = vpath.replace("/codebase/", "").replace("/codebase", "")
        full = os.path.join(project_root, rel)
        ranges = [(int(s), int(e)) for s, e in re.findall(r"<range>(\d+)-(\d+)</range>", fm.group(2))]
        files.append({"path": rel, "full_path": full, "ranges": ranges})
    return {"files": files}

def search_with_content(
    query: str,
    project_root: str,
    api_key: str | None = None,
    max_turns: int = 3,
    max_commands: int = 8,
) -> str:
    """搜索并返回格式化结果（适合 MCP 工具返回）。

    返回 Fast Context 文件列表 + AI 搜索过程中使用的 rg 关键字列表。
    调用方可用这些关键字自行搜索以扩大覆盖范围。
    """
    result = search(
        query=query, project_root=project_root,
        api_key=api_key, max_turns=max_turns, max_commands=max_commands,
    )

    if result.get("error"):
        return f"Error: {result['error']}"

    files = result.get("files", [])
    rg_patterns = result.get("rg_patterns", [])
    # 去重 + 过滤太短的
    unique_patterns = [p for p in dict.fromkeys(rg_patterns) if len(p) >= 3]

    if not files and not unique_patterns:
        raw = result.get("raw_response", "")
        return f"No relevant files found.\n\nRaw response:\n{raw}" if raw else "No relevant files found."

    parts: list[str] = []

    # 第一部分：FC 搜索结果文件
    n = len(files)
    if files:
        parts.append(
            f"Found {n} relevant files. "
            f"IMPORTANT: You MUST examine ALL {n} files below to fully understand the context."
        )
        parts.append("")
        for i, entry in enumerate(files, 1):
            ranges_str = ", ".join(f"L{s}-{e}" for s, e in entry["ranges"])
            parts.append(f"  [{i}/{n}] {entry['full_path']} ({ranges_str})")
    else:
        parts.append("No direct file matches found.")

    # 第二部分：推荐搜索关键字
    if unique_patterns:
        parts.append("")
        parts.append(
            "Suggested search keywords (rg patterns used during AI search). "
            "Use these with grep/rg to discover additional relevant files:"
        )
        parts.append(f"  {', '.join(unique_patterns)}")

    return "\n".join(parts)


def extract_key_info() -> dict:
    """提取 Windsurf API Key 信息（供 MCP 工具使用）。"""
    from extract_key import extract_key
    return extract_key()
