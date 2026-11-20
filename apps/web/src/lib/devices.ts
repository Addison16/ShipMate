/** A short name for a signed-in device from its browser's User-Agent, e.g. "iPhone · Safari". */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android phone"
          : "Android tablet"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? "Unknown device";
}
