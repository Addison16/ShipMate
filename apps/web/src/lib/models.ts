/** crew.yaml `model: default`: follow the crew default set in Settings (see @shipmate/core). */
export const CREW_DEFAULT = "default";

const MODEL_LINE = /^model:[ \t]*["']?([^"'#\s]+)["']?[ \t]*(#.*)?$/m;

/** The `model` of a crew.yaml. */
export function readModel(yaml: string): string {
  return MODEL_LINE.exec(yaml)?.[1] ?? "";
}

/** crew.yaml with its top-level `model` set, other lines untouched. */
export function withModel(yaml: string, model: string): string {
  const line = `model: ${model}`;
  if (MODEL_LINE.test(yaml)) return yaml.replace(MODEL_LINE, line);
  return `${yaml.replace(/\s*$/, "")}\n${line}\n`;
}

/** How a crew member's model reads in lists: the default shows what it currently means. */
export function modelLabel(model: string, crewDefault?: string): string {
  if (model !== CREW_DEFAULT) return model;
  return crewDefault ? `Crew default (${crewDefault})` : "Crew default";
}
