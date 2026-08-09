import { relative, sep } from "node:path";
import { resolveWithinRoot } from "./path-safety.mjs";

/** Repair common model-produced JSON defects without evaluating code. */
export function repairJsonText(text) {
  return String(text)
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)"\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonWithRepair(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJsonText(text));
    } catch {
      return null;
    }
  }
}

function extractBalancedObject(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function collectCommands(text) {
  const commands = [];
  const commandKey = /["']?(command\d+)["']?\s*:\s*\{/g;
  let match;
  while ((match = commandKey.exec(text)) !== null) {
    const start = text.indexOf("{", match.index);
    const value = parseJsonWithRepair(extractBalancedObject(text, start));
    if (value && typeof value === "object" && typeof value.type === "string") {
      commands.push([match[1], value]);
    }
    commandKey.lastIndex = Math.max(commandKey.lastIndex, start + 1);
  }
  return commands;
}

function collectLooseReadfiles(text) {
  const commands = [];
  const filePattern = /["']?file["']?\s*:\s*["'](\/codebase(?:\/[^"'\r\n,}]+)+)["']/g;
  let match;
  while ((match = filePattern.exec(text)) !== null) {
    const window = text.slice(Math.max(0, match.index - 240), Math.min(text.length, filePattern.lastIndex + 240));
    const start = Number(window.match(/["']?start_line["']?\s*:\s*(\d+)/)?.[1] || 0);
    const end = Number(window.match(/["']?end_line["']?\s*:\s*(\d+)/)?.[1] || 0);
    commands.push({
      type: "readfile",
      file: match[1].replace(/\\\//g, "/"),
      ...(start ? { start_line: start } : {}),
      ...(end ? { end_line: end } : {}),
    });
  }
  return commands;
}

/** Recover executable restricted_exec commands from a malformed response. */
export function salvageRestrictedExecArgs(text) {
  const result = {};
  const seen = new Set();
  const add = (key, command) => {
    const signature = JSON.stringify(command);
    if (seen.has(signature)) return;
    seen.add(signature);
    result[key && !result[key] ? key : `command${Object.keys(result).length + 1}`] = command;
  };

  for (const [key, command] of collectCommands(String(text))) add(key, command);
  for (const command of collectLooseReadfiles(String(text))) add(null, command);
  return Object.keys(result).length ? result : null;
}

function collectLoosePaths(text) {
  const paths = [];
  const pattern = /\/codebase\/[A-Za-z0-9_@+.,()\[\]{} !#$%&'=-]+(?:\/[A-Za-z0-9_@+.,()\[\]{} !#$%&'=-]+)*\.[A-Za-z0-9]{1,16}/g;
  for (const match of String(text).matchAll(pattern)) {
    paths.push(match[0].trim());
  }
  return paths;
}

/** Recover safe file hits and rg keywords when structured parsing still fails. */
export function salvageSearchEvidence(text, projectRoot) {
  const source = String(text);
  const commands = salvageRestrictedExecArgs(source) || {};
  const byPath = new Map();
  const rgPatterns = [];

  const addFile = (virtualPath, ranges = []) => {
    let fullPath;
    try {
      fullPath = resolveWithinRoot(projectRoot, virtualPath);
    } catch {
      return;
    }
    const relPath = relative(projectRoot, fullPath).split(sep).join("/");
    const current = byPath.get(fullPath) || { path: relPath, full_path: fullPath, ranges: [] };
    for (const range of ranges) {
      if (!current.ranges.some(([start, end]) => start === range[0] && end === range[1])) {
        current.ranges.push(range);
      }
    }
    byPath.set(fullPath, current);
  };

  for (const command of Object.values(commands)) {
    if (command.type === "readfile" && typeof command.file === "string") {
      const start = Number(command.start_line || 0);
      const end = Number(command.end_line || 0);
      addFile(command.file, start && end ? [[start, end]] : []);
    }
    if (command.type === "rg" && typeof command.pattern === "string") {
      rgPatterns.push(command.pattern);
    }
  }

  for (const path of collectLoosePaths(source)) addFile(path);
  for (const match of source.matchAll(/["']?pattern["']?\s*:\s*["']([^"'\r\n]+)["']/g)) {
    rgPatterns.push(match[1]);
  }

  return {
    files: [...byPath.values()].slice(0, 30),
    rg_patterns: [...new Set(rgPatterns)],
  };
}
