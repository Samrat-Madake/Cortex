// packages/percept/src/providers/python/types.ts
/**
 * Python extension layer provider interfaces.
 *
 * Reserved contract for Python sidecar providers and process-managed
 * inference services.
 *
 * FastAPI contract:
 *   GET /health → { status: "ok", providers: [...] }
 *   GET /providers → [{ name, type, ready }]
 *   POST /infer/{name} → { ...typed output }
 */
export interface PythonRemoteProviderConfig {
  name: string;
  type: string;
  endpoint: string;
}
