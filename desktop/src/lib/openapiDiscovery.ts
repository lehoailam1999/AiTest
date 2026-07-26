import { readTextFile } from "../tauri/bridge";

const OPENAPI_CANDIDATES = [
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.json",
  "docs/openapi.yaml",
  "docs/openapi.json",
  "api/openapi.yaml",
  "api/openapi.json",
];

const MAX_SPEC = 48_000;

/** Read first OpenAPI/Swagger file found under project root (relative paths). */
export async function discoverOpenApiSpec(projectRoot: string): Promise<string> {
  for (const rel of OPENAPI_CANDIDATES) {
    try {
      const text = await readTextFile(projectRoot, rel);
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_SPEC) {
        return trimmed.slice(0, MAX_SPEC) + "\n…[truncated]";
      }
      return trimmed;
    } catch {
      /* try next */
    }
  }
  return "";
}
