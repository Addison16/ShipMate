import { readFileSync } from "node:fs";
import { z } from "zod";

export const CatalogEntry = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** core = bundled and enabled by default; catalog = one-click install. */
  tier: z.enum(["core", "catalog"]),
  transport: z.enum(["stdio", "http"]),
  /** For stdio: how to launch. */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  /** Secrets the server needs; stored in the vault and injected as env vars. */
  secrets: z
    .array(z.object({ env: z.string(), label: z.string(), required: z.boolean().default(true) }))
    .default([]),
  /** None of the secrets is required on its own, but the server needs at least one of them. */
  needsOneSecret: z.boolean().default(false),
  homepage: z.string().optional(),
  /** Signs in through Shipmate with the owner's own OAuth client (Sign in with Google). */
  oauth: z.enum(["google"]).optional(),
  tags: z.array(z.string()).default([]),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

let cache: CatalogEntry[] | undefined;
export function loadCatalog(): CatalogEntry[] {
  if (!cache) {
    const raw = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
    cache = z.array(CatalogEntry).parse(raw);
  }
  return cache;
}
export const coreServers = () => loadCatalog().filter((e) => e.tier === "core");
