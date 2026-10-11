import { request } from "node:http";
import { hostname } from "node:os";
import type { UpdatePlanDto } from "@shipmate/core";
import type { ContainerInfo } from "../shipyard/docker.js";
import { compareVersions, parseVersion } from "./releases.js";

/** One-shot Watchtower: pulls the image, recreates the named container, then exits. */
export const DEFAULT_UPDATER_IMAGE = "containrrr/watchtower:latest";
export const OFFICIAL_IMAGE = "ghcr.io/addison16/shipmate";
const HELPER_LABEL = "io.shipmate.updater";

/** The few Docker calls the updater needs; the Shipyard's DockerClient provides them. */
export interface UpdaterDocker {
  readonly socketPath: string;
  ping(): Promise<boolean>;
  inspectContainer(idOrName: string): Promise<ContainerInfo | null>;
  ensureImage(image: string): Promise<void>;
  createContainer(name: string, spec: Record<string, unknown>): Promise<string>;
  startContainer(id: string): Promise<void>;
}

/** Split "ghcr.io/x/y:1.0" into repository and tag ("latest" when none; null for a digest). */
export function splitImageRef(image: string): { repo: string; tag: string | null } {
  if (image.includes("@")) return { repo: image.slice(0, image.indexOf("@")), tag: null };
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repo: image, tag: "latest" };
}

/**
 * Whether pulling the same tag again can bring `latest`: `latest` and `edge` always move,
 * `1` follows 1.x, `1.2` follows 1.2.x, an exact version or a digest never moves.
 */
export function tagFollows(tag: string | null, latest: string | null): boolean {
  if (tag === null) return false;
  if (tag === "latest" || tag === "edge") return true;
  if (!latest) return /^v?\d+(\.\d+)?$/.test(tag);
  const want = parseVersion(latest);
  if (!want) return false;
  const major = /^v?(\d+)$/.exec(tag);
  if (major) return Number(major[1]) === want.nums[0];
  const minor = /^v?(\d+)\.(\d+)$/.exec(tag);
  if (minor) return Number(minor[1]) === want.nums[0] && Number(minor[2]) === want.nums[1];
  return false;
}

/** Commands to update by hand, for the container as found (or the stock compose setup). */
export function manualCommands(
  self: ContainerInfo | null,
  options: { latest: string | null; current: string },
): string[] {
  const labels = self?.labels ?? {};
  const dir = labels["com.docker.compose.project.working_dir"];
  const service = labels["com.docker.compose.service"] ?? "shipmate";
  const { tag } = splitImageRef(self?.image ?? `${OFFICIAL_IMAGE}:latest`);
  const pinned =
    options.latest !== null &&
    tag !== null &&
    !tagFollows(tag, options.latest) &&
    compareVersions(options.latest, options.current) > 0;
  const out: string[] = [];
  if (pinned) {
    out.push(
      `# The image is pinned to :${tag}. Change it to :${options.latest} in docker-compose.yml first.`,
    );
  }
  if (self && !dir) {
    // A plain `docker run` (Unraid, Portainer...): pull, then recreate it from its template.
    const { repo } = splitImageRef(self.image);
    out.push(`docker pull ${repo}:${pinned ? options.latest : (tag ?? "latest")}`);
    out.push(
      `# Then recreate the "${self.name}" container with the new image (Unraid: Apply update).`,
    );
    return out;
  }
  if (dir) out.push(`cd ${shellQuote(dir)}`);
  out.push(`docker compose pull ${service}`, `docker compose up -d ${service}`);
  return out;
}

const shellQuote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/**
 * One-click updates through the Docker socket. Shipmate cannot replace its own running
 * container, so it starts a short-lived helper (Watchtower with --run-once) that pulls the image
 * for the tag Shipmate runs, recreates the Shipmate container with the same settings, cleans up
 * the old image and exits. Migrations run when the new container boots.
 */
export class Updater {
  constructor(
    private readonly docker: UpdaterDocker,
    private readonly options: {
      current: string;
      /** Our own container's name or id; defaults to the hostname Docker gives it. */
      container?: string | undefined;
      updaterImage?: string | undefined;
      /** The Docker API version to tell the helper; detected from the daemon when unset. */
      apiVersion?: () => Promise<string | null>;
    },
  ) {}

  get updaterImage(): string {
    return this.options.updaterImage || DEFAULT_UPDATER_IMAGE;
  }

  async plan(latest: string | null): Promise<UpdatePlanDto & { self: ContainerInfo | null }> {
    const base = { updaterImage: this.updaterImage };
    const reachable = await this.docker.ping();
    const self = reachable
      ? await this.docker.inspectContainer(this.options.container || hostname()).catch(() => null)
      : null;
    const commands = manualCommands(self, { latest, current: this.options.current });
    const no = (reason: string) => ({
      ...base,
      oneClick: false,
      reason,
      container: self?.name ?? null,
      image: self?.image ?? null,
      commands,
      self,
    });
    if (!reachable) {
      return no(
        `No Docker socket at ${this.docker.socketPath}, so Shipmate cannot update itself. Run these on the host.`,
      );
    }
    if (!self) {
      return no(
        "Shipmate is not running in a container it can see (set SHIPMATE_CONTAINER to its name if it is). Update it the way you installed it.",
      );
    }
    const manager = nasManager(self);
    if (manager) return { ...no(manager.reason), commands: manager.commands };
    const { repo, tag } = splitImageRef(self.image);
    if (tag === null) {
      return no(`The container runs a pinned digest (${self.image}); change it by hand.`);
    }
    if (!tagFollows(tag, latest)) {
      return no(
        `The image tag :${tag} is pinned to one version, so pulling it again brings nothing new. Change the tag, then run these.`,
      );
    }
    const official = repo.toLowerCase() === OFFICIAL_IMAGE;
    return {
      ...base,
      oneClick: true,
      reason: official
        ? `Pulls the newest ${repo}:${tag} and recreates the "${self.name}" container with the same settings. Shipmate is offline for a minute while it restarts.`
        : `Pulls the newest ${repo}:${tag} (a custom image) and recreates the "${self.name}" container with the same settings.`,
      container: self.name,
      image: self.image,
      commands,
      self,
    };
  }

  /** Start the helper; resolves once it is running (the restart happens after). */
  async run(latest: string | null): Promise<{ helper: string }> {
    const plan = await this.plan(latest);
    if (!plan.oneClick || !plan.self) throw new Error(plan.reason);
    const self = plan.self;
    // The helper needs the host's socket: whatever is mounted at our socket path.
    const hostSocket =
      self.mounts.find((m) => m.destination === this.docker.socketPath)?.source ??
      this.docker.socketPath;
    await this.docker.ensureImage(this.updaterImage);
    const apiVersion = await (this.options.apiVersion?.() ??
      dockerApiVersion(this.docker.socketPath));
    const helper = `shipmate-updater-${Date.now().toString(36)}`;
    const id = await this.docker.createContainer(helper, {
      Image: this.updaterImage,
      Cmd: ["--run-once", "--cleanup", self.name],
      // Older Watchtower builds speak an old API version that new Docker engines refuse.
      Env: apiVersion ? [`DOCKER_API_VERSION=${apiVersion}`] : [],
      Labels: { [HELPER_LABEL]: "1" },
      HostConfig: {
        AutoRemove: true,
        Binds: [`${hostSocket}:/var/run/docker.sock`],
      },
    });
    await this.docker.startContainer(id);
    return { helper };
  }
}

/**
 * NAS app managers keep their own record of the container; recreating it behind their back
 * leaves them out of step, so updates go through their UI instead.
 */
export function nasManager(self: ContainerInfo): { reason: string; commands: string[] } | null {
  if (self.labels["net.unraid.docker.managed"]) {
    return {
      reason: "Unraid manages this container. Update it from Unraid so its template stays in step.",
      commands: ["# Unraid: Docker → Check for Updates → Apply Update on the Shipmate container."],
    };
  }
  if ((self.labels["com.docker.compose.project"] ?? "").startsWith("ix-")) {
    return {
      reason: "TrueNAS manages this app. Update it from TrueNAS so the app stays in step.",
      commands: ["# TrueNAS SCALE: Apps → shipmate → Update (or edit the YAML's image tag)."],
    };
  }
  return null;
}

/** The daemon's API version from the Api-Version header of /_ping; null if unknown. */
export function dockerApiVersion(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/_ping", timeout: 3000 }, (res) => {
      res.resume();
      const v = res.headers["api-version"];
      resolve(typeof v === "string" && /^\d+\.\d+$/.test(v) ? v : null);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}
