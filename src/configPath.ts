import { existsSync } from "node:fs";
import path from "node:path";

/** Preserve project-root overrides while keeping bundled data in config/. */
export function configPath(root: string, name: string): string {
  const override = path.join(root, name);
  return existsSync(override) ? override : path.join(root, "config", name);
}
