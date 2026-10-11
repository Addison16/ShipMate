import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CrewDto, InstallStartersResponse, StarterCrewDto, WatchDto } from "@shipmate/core";
import { CREW_FILES, CrewSlug } from "@shipmate/core";
import { parseManifestYaml } from "@shipmate/crew";
import { loadCatalog } from "@shipmate/mcp-catalog";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { HttpError, type UserRow } from "../auth.js";
import type { CrewService } from "./crew.js";
import type { McpService } from "./mcp.js";
import type { SettingsService } from "./settings.js";
import type { WatchService } from "./watches.js";

/** Per-template extras in `starter.yaml`; a template without one is not a starter pack. */
const StarterFile = z.object({
  blurb: z.string().min(1).max(200),
  watch: z
    .object({
      name: z.string().min(1).max(100),
      cron: z.string().min(1).max(120),
      prompt: z.string().min(1).max(20_000),
    })
    .optional(),
});

interface Starter {
  slug: string;
  dir: string;
  blurb: string;
  watch: { name: string; cron: string; prompt: string } | null;
}

/**
 * Starter crew packs: ready-made crew members (Galley, Purser, Navigator, ...) offered at first
 * run and on the Crew page. Each comes from templates/crew/<slug> with a `starter.yaml` and gets
 * the instance's default model, so a fresh install is useful without writing personas by hand.
 */
export class StarterService {
  constructor(
    private readonly templatesDir: string,
    private readonly crew: CrewService,
    private readonly settings: SettingsService,
    private readonly mcp: McpService,
    private readonly watches: WatchService,
  ) {}

  #starters(): Starter[] {
    const root = join(this.templatesDir, "crew");
    if (!existsSync(root)) return [];
    const out: Starter[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !CrewSlug.safeParse(d.name).success) continue;
      const dir = join(root, d.name);
      const file = join(dir, "starter.yaml");
      if (!existsSync(file) || !existsSync(join(dir, CREW_FILES.manifest))) continue;
      const parsed = StarterFile.safeParse(parseYaml(readFileSync(file, "utf8")));
      if (!parsed.success) continue;
      out.push({ slug: d.name, dir, blurb: parsed.data.blurb, watch: parsed.data.watch ?? null });
    }
    return out;
  }

  list(): StarterCrewDto[] {
    return this.#starters().map((s) => {
      const m = parseManifestYaml(readFileSync(join(s.dir, CREW_FILES.manifest), "utf8"));
      return {
        slug: s.slug,
        name: m.name,
        role: m.role,
        blurb: s.blurb,
        mcp: m.mcp,
        watch: s.watch,
        installed: this.crew.registry.has(s.slug),
      };
    });
  }

  async install(
    user: UserRow,
    input: { slugs: string[]; watches?: boolean | undefined; timezone?: string | undefined },
  ): Promise<InstallStartersResponse> {
    const starters = new Map(this.#starters().map((s) => [s.slug, s]));
    for (const slug of input.slugs) {
      if (!starters.has(slug)) throw new HttpError(400, `"${slug}" is not a starter crew member`);
    }
    if (input.timezone && !isTimeZone(input.timezone)) {
      throw new HttpError(400, `unknown timezone "${input.timezone}"`);
    }
    const { defaultModel } = await this.settings.get();
    const catalog = new Map(loadCatalog().map((e) => [e.id, e]));
    const crew: CrewDto[] = [];
    const watches: WatchDto[] = [];
    const notes: string[] = [];
    const needServers = new Set<string>();

    for (const slug of new Set(input.slugs)) {
      const starter = starters.get(slug);
      if (!starter) continue;
      if (this.crew.registry.has(slug)) {
        notes.push(`${slug} is already aboard, so it was left as it is.`);
        continue;
      }
      const manifest = parseManifestYaml(
        readFileSync(join(starter.dir, CREW_FILES.manifest), "utf8"),
      );
      const persona = readFileSync(join(starter.dir, CREW_FILES.persona), "utf8");
      // The default model is the one the owner picked for new crew; it is likely to work here.
      const created = await this.crew.create({
        slug,
        manifest: { ...manifest, model: defaultModel },
        persona,
        createdById: user.id,
        status: "active",
      });
      crew.push(created);
      for (const id of manifest.mcp) {
        if (catalog.get(id)?.tier === "catalog") needServers.add(id);
      }
      if (input.watches !== false && starter.watch) {
        watches.push(
          await this.watches.create(user, {
            name: `${created.name}: ${starter.watch.name}`,
            crewSlug: slug,
            trigger: {
              kind: "cron",
              expression: starter.watch.cron,
              ...(input.timezone ? { timezone: input.timezone } : {}),
            },
            prompt: starter.watch.prompt.trim(),
            // Opt-in: nothing runs or spends until someone turns it on.
            enabled: false,
          }),
        );
      }
    }

    for (const id of needServers) {
      const entry = catalog.get(id);
      const name = entry?.name ?? id;
      if (user.role === "owner") {
        const server = await this.mcp.install(id);
        const missing = server.secrets.filter((s) => s.required && !s.set).map((s) => s.label);
        if (missing.length) {
          notes.push(
            `${name} needs ${missing.join(", ")} on the MCP servers page before it starts.`,
          );
        }
      } else {
        const server = await this.mcp.get(id).catch(() => null);
        if (!server?.installed)
          notes.push(`Ask the owner to install ${name} on the MCP servers page.`);
      }
    }
    if (watches.length) {
      notes.push("Starter watches are paused. Turn on the ones you want on the Watches page.");
    }
    return { crew, watches, notes };
  }
}

export const InstallStartersSchema = z.object({
  slugs: z.array(CrewSlug).min(1).max(20),
  watches: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
