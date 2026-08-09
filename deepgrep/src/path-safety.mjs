import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

function isOutside(root, target) {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function isAnyAbsolute(value) {
  return isAbsolute(value) || win32.isAbsolute(value);
}

/**
 * Resolve an untrusted model/tool path inside one project root.
 * Raw absolute paths are accepted only when they remain inside the root;
 * `/codebase/...` is the model-facing virtual root.
 * Existing symlinks are canonicalized so they cannot escape the project.
 */
export function resolveWithinRoot(projectRoot, input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("missing or invalid path");
  }

  const lexicalRoot = resolve(projectRoot);
  const canonicalRoot = existsSync(lexicalRoot) ? realpathSync(lexicalRoot) : lexicalRoot;
  const value = input.trim();
  const virtualMatch = value.match(/^[/\\]codebase(?:[/\\](.*))?$/s);

  let rel;
  let lexicalTarget;
  if (virtualMatch) {
    rel = virtualMatch[1] || "";
  } else {
    if (isAbsolute(value)) {
      lexicalTarget = resolve(value);
      rel = null;
    } else if (win32.isAbsolute(value)) {
      throw new Error(`path outside codebase: ${input}`);
    } else {
      rel = value;
    }
  }

  if (rel !== null && isAnyAbsolute(rel)) {
    throw new Error(`path outside codebase: ${input}`);
  }

  lexicalTarget ||= resolve(lexicalRoot, rel.replace(/[\\/]+/g, sep));
  if (isOutside(lexicalRoot, lexicalTarget)) {
    throw new Error(`path outside codebase: ${input}`);
  }

  if (existsSync(lexicalTarget)) {
    const canonicalTarget = realpathSync(lexicalTarget);
    if (isOutside(canonicalRoot, canonicalTarget)) {
      throw new Error(`path outside codebase: ${input}`);
    }
    return lexicalTarget;
  }

  return lexicalTarget;
}
