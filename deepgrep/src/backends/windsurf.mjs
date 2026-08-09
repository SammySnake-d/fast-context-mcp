/**
 * Windsurf backend — wraps the core Windsurf/Devstral protocol search.
 */
import { search } from "../core.mjs";

export class WindsurfBackend {
  name = "windsurf";
  model = "SWE-1.6";

  /**
   * @param {{ query: string, projectRoot: string, maxTurns?: number, maxCommands?: number, maxResults?: number, treeDepth?: number, timeoutMs?: number, excludePaths?: string[], onProgress?: function }} opts
   */
  async search(opts) {
    return search(opts);
  }
}
