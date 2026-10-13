import postgres from "postgres";

/**
 * postgres() that also understands libpq's Unix socket form, a percent-encoded directory as the
 * host (postgres://shipmate@%2Frun%2Fpostgresql/shipmate). The image's bundled database is
 * reached this way, so it never listens on a network port.
 */
// biome-ignore lint/complexity/noBannedTypes: postgres.js's own default for the types map.
export function connect(url: string, options: postgres.Options<{}> = {}) {
  const dir = socketDir(url);
  return postgres(url, dir ? { ...options, host: dir } : options);
}

export function socketDir(url: string): string | undefined {
  try {
    const host = decodeURIComponent(new URL(url).hostname);
    return host.startsWith("/") ? host : undefined;
  } catch {
    return undefined;
  }
}
