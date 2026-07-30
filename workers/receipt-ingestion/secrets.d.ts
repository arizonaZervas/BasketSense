/**
 * Wrangler cannot infer secret bindings. These names are intentionally typed
 * separately from the generated non-secret binding declaration.
 */
interface Env {
  GEMINI_API_KEY: string;
  INGESTION_INTERNAL_TOKEN: string;
}
