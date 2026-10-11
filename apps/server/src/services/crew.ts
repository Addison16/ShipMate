import { join } from "node:path";
import type { CrewDetailDto, CrewDto, CrewManifest, CrewStatus } from "@shipmate/core";
import {
  CAPTAIN_SLUG,
  type CrewFolder,
  CrewRegistry,
  CrewValidationError,
  MemoryStore,
  parseManifestYaml,
} from "@shipmate/crew";
import { crewMembers, type Db } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";

type CrewRow = typeof crewMembers.$inferSelect;

/**
 * The crew: folders on disk are the source of truth for what a crew member is; the database
 * row carries status (pending review, retired) and gives usage and messages a stable id.
 */
export class CrewService {
  readonly registry: CrewRegistry;
  #listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    crewDir: string,
    private readonly templatesDir: string,
  ) {
    this.registry = new CrewRegistry(crewDir);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    for (const l of this.#listeners) l();
  }

  /** First boot seeds the Captain; every boot mirrors disk into the database. */
  async boot(options: { name?: string; model?: string } = {}): Promise<void> {
    if (!this.registry.has(CAPTAIN_SLUG)) {
      this.registry.seedCaptain(join(this.templatesDir, "crew", "captain"), options);
    }
    for (const folder of this.registry.list()) await this.#mirror(folder);
  }

  async renameCaptain(name: string): Promise<void> {
    const folder = this.registry.seedCaptain(join(this.templatesDir, "crew", "captain"), { name });
    await this.#mirror(folder);
    this.#changed();
  }

  captain(): CrewFolder {
    return this.registry.get(CAPTAIN_SLUG);
  }

  memory(slug: string): MemoryStore {
    return new MemoryStore(this.folder(slug).dir);
  }

  folder(slug: string): CrewFolder {
    try {
      return this.registry.get(slug);
    } catch (err) {
      if (err instanceof CrewValidationError) throw new HttpError(404, err.message);
      throw err;
    }
  }

  async list(includeRetired = false): Promise<CrewDto[]> {
    const rows = new Map((await this.db.select().from(crewMembers)).map((r) => [r.slug, r]));
    const out: CrewDto[] = [];
    for (const folder of this.registry.list()) {
      const row = rows.get(folder.slug) ?? (await this.#mirror(folder));
      const dto = toDto(folder, row);
      if (includeRetired || dto.status !== "retired") out.push(dto);
    }
    return out.sort(
      (a, b) => Number(b.captain) - Number(a.captain) || a.name.localeCompare(b.name),
    );
  }

  async detail(slug: string): Promise<CrewDetailDto> {
    const folder = this.folder(slug);
    const row = await this.row(slug);
    return {
      ...toDto(folder, row),
      manifestYaml: this.registry.readManifestYaml(slug),
      persona: folder.persona,
    };
  }

  async row(slug: string): Promise<CrewRow> {
    const [row] = await this.db.select().from(crewMembers).where(eq(crewMembers.slug, slug));
    return row ?? this.#mirror(this.folder(slug));
  }

  async create(input: {
    slug: string;
    manifest: Partial<CrewManifest> & { name: string; role: string; model: string };
    persona: string;
    createdById: string | null;
    status: CrewStatus;
  }): Promise<CrewDetailDto> {
    const existing = await this.db
      .select()
      .from(crewMembers)
      .where(eq(crewMembers.slug, input.slug));
    if (existing.length && !this.registry.has(input.slug)) {
      // A row without a folder (deleted by hand): drop it so the slug can be reused.
      await this.db.delete(crewMembers).where(eq(crewMembers.slug, input.slug));
    }
    const folder = this.#validated(() =>
      this.registry.create(input.slug, input.manifest, input.persona),
    );
    await this.#mirror(folder, { status: input.status, createdById: input.createdById });
    this.#changed();
    return this.detail(folder.slug);
  }

  async update(slug: string, patch: { manifestYaml?: string; persona?: string }) {
    if (patch.manifestYaml !== undefined)
      this.#validated(() => parseManifestYaml(patch.manifestYaml ?? ""));
    const folder = this.#validated(() => this.registry.update(slug, patch));
    await this.#mirror(folder);
    this.#changed();
    return this.detail(slug);
  }

  async patch(slug: string, changes: Partial<CrewManifest>, persona?: string) {
    let folder = this.#validated(() => this.registry.patchManifest(slug, changes));
    if (persona !== undefined) folder = this.registry.update(slug, { persona });
    await this.#mirror(folder);
    this.#changed();
    return this.detail(slug);
  }

  async setStatus(slug: string, status: CrewStatus): Promise<CrewDetailDto> {
    const folder = this.folder(slug);
    if (folder.manifest.captain && status !== "active") {
      throw new HttpError(400, "the Captain cannot be retired");
    }
    await this.#mirror(folder, { status });
    this.#changed();
    return this.detail(slug);
  }

  #validated<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CrewValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async #mirror(
    folder: CrewFolder,
    extra: { status?: CrewStatus; createdById?: string | null } = {},
  ): Promise<CrewRow> {
    const m = folder.manifest;
    const base = {
      name: m.name,
      role: m.role,
      model: m.model,
      captain: m.captain,
      visibility: m.visibility,
      manifest: m,
    };
    const status = extra.status;
    const [row] = await this.db
      .insert(crewMembers)
      .values({
        slug: folder.slug,
        ...base,
        status: status === "retired" ? "active" : (status ?? "active"),
        retiredAt: status === "retired" ? new Date() : null,
        createdById: extra.createdById ?? null,
      })
      .onConflictDoUpdate({
        target: crewMembers.slug,
        set: {
          ...base,
          ...(status === "retired" ? { retiredAt: new Date() } : {}),
          ...(status && status !== "retired" ? { status, retiredAt: null } : {}),
        },
      })
      .returning();
    if (!row) throw new Error("crew mirror failed");
    return row;
  }
}

function toDto(folder: CrewFolder, row: CrewRow): CrewDto {
  const m = folder.manifest;
  const status: CrewStatus = row.retiredAt
    ? "retired"
    : row.status === "pending_review"
      ? "pending_review"
      : "active";
  return {
    slug: folder.slug,
    name: m.name,
    role: m.role,
    model: m.model,
    captain: m.captain,
    visibility: m.visibility,
    status,
    tools: m.tools,
    mcp: m.mcp,
    skills: m.skills,
    avatar: m.avatar ?? null,
  };
}
