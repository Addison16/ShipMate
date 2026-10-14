/**
 * Checks a pet the Captain drew as an SVG. Only plain shapes and gradients get through: no
 * scripts, event handlers, links, embedded pictures, styles or text. The picture is also only
 * ever shown through <img> and served with a locked-down Content-Security-Policy, but nothing
 * active is stored in the first place. Errors are worded for the model to fix and retry.
 */

export const MAX_SVG_BYTES = 60_000;

const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "circle",
  "ellipse",
  "rect",
  "path",
  "polygon",
  "polyline",
  "line",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "use",
]);

const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9:_.-]*$/;

export function checkPetSvg(input: string): { svg: string } | { error: string } {
  let svg = input.trim();
  // Models often wrap code in a fence.
  const fenced = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i.exec(svg);
  if (fenced?.[1]) svg = fenced[1].trim();
  svg = svg.replace(/^<\?xml[^>]*\?>\s*/i, "");
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) {
    return { error: "The SVG is too big. Use fewer shapes (under 40) and shorter paths." };
  }
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) {
    return { error: "The svg must start with <svg ...> and end with </svg>, with nothing else." };
  }
  if (/<!|<\?|&[a-z#]/i.test(svg)) {
    return { error: "Remove comments, doctype and entities (things starting with <! or &)." };
  }
  // Every tag: its name and its attributes.
  const tag = /<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g;
  const rest = svg.replace(tag, "");
  if (/[<>]/.test(rest)) return { error: "The SVG has a broken tag. Check every < and >." };
  let inText = 0;
  for (const m of svg.matchAll(tag)) {
    const name = (m[1] ?? "").toLowerCase();
    const closing = m[0].startsWith("</");
    if (!ELEMENTS.has(name)) {
      return {
        error: `<${name}> is not allowed. Use only svg, g, defs, circle, ellipse, rect, path, polygon, polyline, line and gradients.`,
      };
    }
    if (name === "title" || name === "desc") inText += closing ? -1 : 1;
    if (closing) continue;
    const attrs = (m[2] ?? "").replace(/\/\s*$/, "");
    const attr = /\s*([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const leftover = attrs.replace(attr, "").trim();
    if (leftover)
      return {
        error: `The attributes of <${name}> are malformed near "${leftover.slice(0, 40)}".`,
      };
    for (const a of attrs.matchAll(attr)) {
      const key = (a[1] ?? "").toLowerCase();
      const value = a[3] ?? a[4] ?? "";
      if (!ATTRIBUTE_NAME.test(key) || key.startsWith("on")) {
        return { error: `The attribute ${key} is not allowed.` };
      }
      if (key === "style") return { error: "Do not use style; set fill and stroke directly." };
      if (key === "href" || key === "xlink:href") {
        if (!/^#[A-Za-z][\w-]*$/.test(value)) {
          return { error: "Links are not allowed; href may only point inside the SVG (#id)." };
        }
      }
      if (/url\(\s*(?!#)/i.test(value) || /javascript:|data:/i.test(value)) {
        return { error: "Only url(#id) references inside the SVG are allowed." };
      }
    }
  }
  // Text outside <title>/<desc> would show nothing anyway; refuse it so pets carry no words.
  const outside = svg
    .replace(/<(title|desc)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(tag, "")
    .trim();
  if (outside || inText !== 0) return { error: "No text in the pet: only shapes." };
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) {
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return { svg };
}
