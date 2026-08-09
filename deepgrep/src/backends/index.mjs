/**
 * Backend registry — unified entry point for all search backends.
 * Adding a new provider: implement { name, model, async search(opts) } and register here.
 */
import { WindsurfBackend } from "./windsurf.mjs";
import { OpenAIBackend } from "./openai.mjs";

const _backends = new Map();

// Register built-in backends
_backends.set("windsurf", new WindsurfBackend());
_backends.set("openai", new OpenAIBackend());

/**
 * Get a backend by name.
 * @param {"windsurf"|"openai"|string} name
 * @returns {{ name: string, model: string, search: function }}
 */
export function getBackend(name) {
  const b = _backends.get(name);
  if (!b) throw new Error(`Unknown backend: "${name}". Available: ${[..._backends.keys()].join(", ")}`);
  return b;
}

/**
 * Register a custom backend.
 * @param {{ name: string, model: string, search: function }} backend
 */
export function registerBackend(backend) {
  _backends.set(backend.name, backend);
}

/** List all registered backend names. */
export function listBackends() {
  return [..._backends.keys()];
}
