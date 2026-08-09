/**
 * OpenAI-compatible backend — wraps the OpenAI/deep search protocol.
 * Per-call config (model/baseUrl/apiKey) passed via opts to avoid process.env mutation.
 */
import { searchOpenAI } from "../openai-backend.mjs";

export class OpenAIBackend {
  name = "openai";

  async search(opts) {
    // opts may contain model/baseUrl/apiKey for per-call config (no env mutation)
    return searchOpenAI(opts);
  }
}
