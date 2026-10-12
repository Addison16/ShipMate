/**
 * Copy text, also on plain http. Browsers only offer `navigator.clipboard` on https or localhost,
 * and self-hosted instances are often opened at a LAN address like http://192.168.1.20:8100, so
 * fall back to selecting a hidden textarea and the older copy command there.
 */
export async function copyText(
  text: string,
  env: { clipboard?: Pick<Clipboard, "writeText"> | undefined; doc?: Document } = {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    doc: typeof document !== "undefined" ? document : undefined,
  },
): Promise<void> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return;
    } catch {
      // Permission refused or not focused: try the fallback.
    }
  }
  const doc = env.doc;
  if (!doc) throw new Error("copying is not available here");
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  doc.body.appendChild(area);
  const active = doc.activeElement as HTMLElement | null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    if (!doc.execCommand("copy")) throw new Error("the browser refused to copy");
  } finally {
    area.remove();
    active?.focus?.();
  }
}
