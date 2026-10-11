import type { WatchTemplateDto } from "@shipmate/core";
import type { UserRow } from "../auth.js";
import type { CrewService } from "./crew.js";

const DAILY_BRIEFING_PROMPT = `Write my morning briefing for today. Keep it short and easy to skim, use these sections in this order, and leave out a section only when it has nothing in it.

1. **Weather**: today's forecast for home with get_weather, and what it means (coat, umbrella, sunscreen).
2. **Today's calendar**: if you have calendar tools, today's events in time order, with clashes and early starts called out. If you have no calendar tools, write "Calendar not connected" and move on.
3. **Due soon**: due_soon for the next 3 days, overdue first, with amounts from the notes.
4. **Overnight**: recent_activity for the last 12 hours. Say what the crew did, and point out failed watches or anything waiting for me.

End with one line: the most important thing to do today. Do not change anything; this is a read-only summary.`;

/**
 * Ready-made watches. The daily briefing goes to the Navigator when it is aboard (it has the
 * calendar), otherwise the Captain; weather, due items and activity come from tools every crew
 * member has, so the briefing works with nothing connected.
 */
export async function watchTemplates(
  crew: CrewService,
  user: UserRow,
): Promise<WatchTemplateDto[]> {
  const aboard = (await crew.list(false, user)).filter((c) => c.status === "active");
  const navigator = aboard.find((c) => c.slug === "navigator");
  const captain = aboard.find((c) => c.captain);
  const runner = navigator ?? captain ?? aboard[0];
  if (!runner) return [];
  return [
    {
      id: "daily-briefing",
      name: "Daily briefing",
      description:
        "Each morning: the weather, today's calendar (when connected), bills and to-dos due soon, and what the crew did overnight.",
      crewSlug: runner.slug,
      cron: "0 7 * * *",
      prompt: DAILY_BRIEFING_PROMPT,
    },
  ];
}
