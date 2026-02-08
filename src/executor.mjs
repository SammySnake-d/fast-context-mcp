/**
 * Tool executor for Windsurf's restricted commands.
 *
 * Uses @vscode/ripgrep for built-in rg binary — no system install needed.
 * Matches Python ToolExecutor behavior exactly.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import treeNodeCli from "tree-node-cli";

const RESULT_MAX_LINES = 50;
const LINE_MAX_CHARS = 250;

export class ToolExecutor {
  /**
   * @param {string} projectRoot
   */
  constructor(projectRoot) {
    this.root = resolve(projectRoot);
    /** @type {string[]} */
    this.collectedRgPatterns = [];
  }

  /**
   * Map virtual /codebase path to real filesystem path.
   * @param {string} virtual
   * @returns {string}
   */
  _real(virtual) {
    if (virtual.startsWith("/codebase")) {
      const rel = virtual.slice("/codebase".length).replace(/^\/+/, "");
      return join(this.root, rel);
    }
    return virtual;
  }

  /**
   * Truncate output to match Windsurf behavior:
   * 50 line limit, 250 char per-line silent truncation.
   * @param {string} text
   * @returns {string}
   */
  static _truncate(text) {
    const lines = text.split("\n");
    const truncatedLines = [];
    const limit = Math.min(lines.length, RESULT_MAX_LINES);
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      truncatedLines.push(line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) : line);
    }
    let result = truncatedLines.join("\n");
    if (lines.length > RESULT_MAX_LINES) {
      result += "\n... (lines truncated) ...";
    }
    return result;
  }

  /**
   * Replace real project root with /codebase in output.
   * @param {string} text
   * @returns {string}
   */
  _remap(text) {
    // Replace both forward-slash and native-sep versions
    return text.replaceAll(this.root, "/codebase");
  }

  /**
   * Check if a file matches any glob pattern (simplified fnmatch).
   * @param {string} relPath
   * @param {string} filename
   * @param {string[]} patterns
   * @returns {boolean}
   */
  static _globMatch(relPath, filename, patterns) {
    for (const pat of patterns) {
      const normalized = pat.replace(/\\/g, "/");
      if (normalized.startsWith("**/")) {
        const sub = normalized.slice(3);
        if (sub.includes("/**")) continue; // directory pattern, handled by skipDirs
        if (_fnmatch(filename, sub)) return true;
      } else if (_fnmatch(relPath, normalized)) {
        return true;
      } else if (_fnmatch(filename, normalized)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Search for pattern using @vscode/ripgrep.
   * @param {string} pattern
   * @param {string} path
   * @param {string[]|null} [include]
   * @param {string[]|null} [exclude]
   * @returns {string}
   */
  rg(pattern, path, include = null, exclude = null) {
    this.collectedRgPatterns.push(pattern);
    const rp = this._real(path);
    if (!existsSync(rp)) {
      return `Error: path does not exist: ${path}`;
    }

    const args = ["--no-heading", "-n", "--max-count", "50", pattern, rp];
    if (include) {
      for (const g of include) {
        args.push("--glob", g);
      }
    }
    if (exclude) {
      for (const g of exclude) {
        args.push("--glob", `!${g}`);
      }
    }

    try {
      const stdout = execFileSync(rgPath, args, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
      });
      return ToolExecutor._truncate(this._remap(stdout || "(no matches)"));
    } catch (err) {
      // rg exits with code 1 when no matches found — that's normal
      if (err.status === 1) {
        return "(no matches)";
      }
      // rg exits with code 2 on errors
      if (err.stderr) {
        return ToolExecutor._truncate(this._remap(err.stderr));
      }
      return `Error: ${err.message}`;
    }
  }

  /**
   * Read file contents with optional line range (1-indexed, inclusive).
   * @param {string} file
   * @param {number|null} [startLine]
   * @param {number|null} [endLine]
   * @returns {string}
   */
  readfile(file, startLine = null, endLine = null) {
    const rp = this._real(file);
    try {
      const stat = statSync(rp);
      if (!stat.isFile()) {
        return `Error: file not found: ${file}`;
      }
    } catch {
      return `Error: file not found: ${file}`;
    }

    let content;
    try {
      content = readFileSync(rp, "utf-8");
    } catch (e) {
      return `Error: ${e.message}`;
    }

    const allLines = content.split("\n");
    // If the file ends with a newline, there'll be an empty string at the end
    // Keep behavior consistent with Python readlines()
    const s = (startLine || 1) - 1;
    const e = endLine || allLines.length;
    const selected = allLines.slice(s, e);
    const out = selected.map((line, idx) => `${s + idx + 1}:${line}`).join("\n");
    return ToolExecutor._truncate(out);
  }

  /**
   * Display directory structure as a tree.
   * @param {string} path
   * @param {number|null} [levels]
   * @returns {string}
   */
  tree(path, levels = null) {
    const rp = this._real(path);
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: dir not found: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    try {
      const opts = {};
      if (levels) opts.maxDepth = levels;
      let stdout = treeNodeCli(rp, opts);
      // tree-node-cli outputs basename as root line; replace with virtual path
      const dirName = rp.split("/").pop() || rp.split("\\").pop() || rp;
      const lines = stdout.split("\n");
      if (lines[0] === dirName) {
        lines[0] = path;
        stdout = lines.join("\n");
      }
      return ToolExecutor._truncate(this._remap(stdout));
    } catch {
      return `Error: failed to generate tree for ${path}`;
    }
  }

  /**
   * List files in a directory.
   * @param {string} path
   * @param {boolean} [longFormat=false]
   * @param {boolean} [allFiles=false]
   * @returns {string}
   */
  ls(path, longFormat = false, allFiles = false) {
    const rp = this._real(path);
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: not a directory: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    let entries;
    try {
      entries = readdirSync(rp).sort();
    } catch (e) {
      return `Error: ${e.message}`;
    }

    if (!allFiles) {
      entries = entries.filter((e) => !e.startsWith("."));
    }

    if (!longFormat) {
      return ToolExecutor._truncate(entries.join("\n"));
    }

    // Long format: emulate ls -l output
    const lines = [`total ${entries.length}`];
    for (const name of entries) {
      const fp = join(rp, name);
      try {
        const st = statSync(fp);
        const isDir = st.isDirectory();
        const type = isDir ? "d" : "-";
        const perm = "rwxr-xr-x";
        const size = String(st.size).padStart(8);
        const mtime = st.mtime;
        const month = mtime.toLocaleString("en", { month: "short" });
        const day = String(mtime.getDate()).padStart(2);
        const hh = String(mtime.getHours()).padStart(2, "0");
        const mm = String(mtime.getMinutes()).padStart(2, "0");
        const dateStr = `${month} ${day} ${hh}:${mm}`;
        lines.push(`${type}${perm}  1 user  staff ${size} ${dateStr} ${name}`);
      } catch {
        lines.push(`?---------  ? ?     ?        ? ? ?     ? ${name}`);
      }
    }
    return ToolExecutor._truncate(this._remap(lines.join("\n")));
  }

  /**
   * Glob pattern matching.
   * @param {string} pattern
   * @param {string} path
   * @param {string} [typeFilter="all"]
   * @returns {string}
   */
  glob(pattern, path, typeFilter = "all") {
    const rp = this._real(path);

    // Use recursive readdir + fnmatch since Node 22 globSync may not be available
    const matches = [];
    const fullPattern = join(rp, pattern).replace(/\\/g, "/");

    try {
      _globWalk(rp, pattern, matches, typeFilter);
    } catch {
      // fallback: try simple readdir
      try {
        const entries = readdirSync(rp);
        for (const entry of entries) {
          const fp = join(rp, entry);
          if (_fnmatch(entry, pattern)) {
            try {
              const st = statSync(fp);
              if (typeFilter === "file" && !st.isFile()) continue;
              if (typeFilter === "directory" && !st.isDirectory()) continue;
              matches.push(fp);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    const sorted = matches.sort().slice(0, 100);
    const out = sorted.map((m) => this._remap(m)).join("\n");
    return out || "(no matches)";
  }

  /**
   * Dispatch a command dict to the appropriate method.
   * @param {Object} cmd
   * @returns {string}
   */
  execCommand(cmd) {
    const t = cmd.type || "";
    switch (t) {
      case "rg":
        return this.rg(cmd.pattern, cmd.path, cmd.include || null, cmd.exclude || null);
      case "readfile":
        return this.readfile(cmd.file, cmd.start_line || null, cmd.end_line || null);
      case "tree":
        return this.tree(cmd.path, cmd.levels || null);
      case "ls":
        return this.ls(cmd.path, cmd.long_format || false, cmd.all || false);
      case "glob":
        return this.glob(cmd.pattern, cmd.path, cmd.type_filter || "all");
      default:
        return `Error: unknown command type '${t}'`;
    }
  }

  /**
   * Execute all commandN keys from a tool call args dict.
   * @param {Object} args
   * @returns {string}
   */
  execToolCall(args) {
    const parts = [];
    const keys = Object.keys(args).filter((k) => k.startsWith("command")).sort();
    for (const key of keys) {
      if (typeof args[key] === "object") {
        const output = this.execCommand(args[key]);
        parts.push(`<${key}_result>\n${output}\n</${key}_result>`);
      }
    }
    return parts.join("");
  }
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Simple fnmatch-like glob matching.
 * Supports *, ?, and ** patterns.
 * @param {string} str
 * @param {string} pattern
 * @returns {boolean}
 */
function _fnmatch(str, pattern) {
  // Convert glob pattern to regex
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === "[") {
      // Pass through character classes
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regex += "\\[";
      } else {
        regex += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (".+^${}()|\\".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
    i++;
  }
  regex += "$";
  try {
    return new RegExp(regex).test(str);
  } catch {
    return false;
  }
}

/**
 * Recursive glob walk.
 * @param {string} base
 * @param {string} pattern
 * @param {string[]} matches
 * @param {string} typeFilter
 */
function _globWalk(base, pattern, matches, typeFilter) {
  const isRecursive = pattern.includes("**");

  const walk = (dir, depth) => {
    if (matches.length >= 100) return;
    if (!isRecursive && depth > 0) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 100) return;
      const fp = join(dir, entry);
      const relFromBase = relative(base, fp).replace(/\\/g, "/");

      let st;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }

      if (_fnmatch(relFromBase, pattern) || _fnmatch(entry, pattern)) {
        if (typeFilter === "file" && !st.isFile()) continue;
        if (typeFilter === "directory" && !st.isDirectory()) continue;
        matches.push(fp);
      }

      if (st.isDirectory() && !entry.startsWith(".") && isRecursive) {
        walk(fp, depth + 1);
      }
    }
  };

  walk(base, 0);
}
