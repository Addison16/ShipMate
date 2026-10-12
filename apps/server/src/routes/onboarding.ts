import {
  applyOnboardingUpdate,
  CAPTAIN_VOICES,
  type CaptainSetupDto,
  matchVoice,
  type OnboardingDto,
  OnboardingUpdate,
  parseOnboarding,
  voiceSection,
  withVoiceSection,
} from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

export const ONBOARDING_KEY = "onboarding";

export async function onboardingState(s: Services): Promise<OnboardingDto> {
  return parseOnboarding(await s.settings.getJson(ONBOARDING_KEY));
}

function captainDto(s: Services): CaptainSetupDto {
  const captain = s.crew.captain();
  const voice = voiceSection(captain.persona);
  return { name: captain.manifest.name, voiceId: matchVoice(voice), voice, voices: CAPTAIN_VOICES };
}

/** The owner's first-launch guide: where it is, and the Captain's name and personality. */
export async function onboardingRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/onboarding", async (req) => {
    requireRole(req.user, "owner");
    return { onboarding: await onboardingState(s) };
  });

  app.put("/api/onboarding", async (req) => {
    requireRole(req.user, "owner");
    const update = OnboardingUpdate.parse(req.body);
    const next = applyOnboardingUpdate(await onboardingState(s), update);
    await s.settings.setJson(ONBOARDING_KEY, next);
    return { onboarding: parseOnboarding(next) };
  });

  app.get("/api/onboarding/captain", async (req) => {
    requireRole(req.user, "owner");
    return captainDto(s);
  });

  app.put("/api/onboarding/captain", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        voice: z.string().trim().min(1).max(2000),
      })
      .parse(req.body);
    if (body.name && body.name !== s.crew.captain().manifest.name) {
      await s.settings.set({ captainName: body.name });
      await s.crew.renameCaptain(body.name);
    }
    const text = CAPTAIN_VOICES.find((v) => v.id === body.voice)?.text ?? body.voice;
    const { persona } = s.crew.captain();
    // Leave an untouched stock CREW.md byte-for-byte alone so later template upgrades still apply.
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    if (norm(voiceSection(persona)) !== norm(text)) {
      await s.crew.update(CAPTAIN_SLUG, { persona: withVoiceSection(persona, text) });
    }
    return captainDto(s);
  });
}
