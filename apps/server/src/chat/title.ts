/**
 * A chat's name, made from its first message without asking a model: the opening greeting and
 * "can you please" are dropped, it stops at the end of the first sentence, and it is cut at a
 * word, never mid-word.
 */

const MAX_TITLE = 60;

const GREETING =
  /^(?:(?:hi|hey|hello|yo|hiya|good (?:morning|afternoon|evening)|thanks|thank you|ok|okay|so|um)\b[\s,!.]*(?:there|captain|team|all|everyone|guys)?[\s,!.:;-]*)+/i;
const ASKING =
  /^(?:(?:can|could|would|will) you(?: please)?|please(?: can you)?|i(?: would|'d) like you to|i need you to|i want you to|help me(?: to)?)\s+/i;

export function chatTitle(text: string, fileNames: string[] = []): string {
  const flat = text
    // Code and links make poor names.
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let title = flat.replace(GREETING, "");
  title = title.replace(ASKING, "").trim() || flat;
  // The first sentence, when it is long enough to say something.
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(title)?.[1];
  if (sentence) title = sentence;
  title = title.replace(/[\s.,;:!-]+$/, "");
  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE - 1);
    const space = cut.lastIndexOf(" ");
    title = `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s.,;:!-]+$/, "")}…`;
  }
  if (!title) title = fileNames.join(", ").slice(0, MAX_TITLE) || flat.slice(0, MAX_TITLE);
  return title.charAt(0).toUpperCase() + title.slice(1);
}
