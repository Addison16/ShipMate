import type { ProfileDto } from "@shipmate/core";
import { type ReactNode, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth, useUser } from "../auth.js";
import { AppearanceSettings } from "../components/AppearanceSettings.js";
import { Logo } from "../components/Logo.js";
import { PushSettings } from "../components/PushSettings.js";
import { Button, ErrorText, Loading, TextAreaField, TextField } from "../components/ui.js";
import { browserTimeZone } from "../lib/starters.js";
import { useResource } from "../lib/useResource.js";
import { navigate } from "../router.js";
import { TourGrid } from "./Onboarding.js";

type Step = "profile" | "notifications" | "tour";
const STEPS: Step[] = ["profile", "notifications", "tour"];

/**
 * A short first sign-in welcome for people the owner added: a few profile facts, notifications
 * and theme on this device, then a tour. Shown once; the server remembers it was seen.
 */
export function WelcomePage() {
  const user = useUser();
  const { setUser } = useAuth();
  const [step, setStep] = useState<Step>("profile");
  const [error, setError] = useState<string | null>(null);
  const i = STEPS.indexOf(step);

  async function done(path = "/bridge") {
    setError(null);
    try {
      navigate(path);
      const { user: next } = await api.updatePreferences({ welcome: "done" });
      setUser(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const next = () => {
    setStep(STEPS[i + 1] ?? "tour");
    window.scrollTo({ top: 0 });
  };

  return (
    <main className="min-h-dvh bg-gradient-to-b from-accent-50 to-slate-50 px-4 py-6 sm:py-10 dark:from-accent-950/40 dark:to-slate-950">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-slate-900 dark:text-white">
            <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm">
              <Logo size={22} />
            </span>
            <span className="text-xl font-semibold tracking-tight">Shipmate</span>
          </div>
          {step !== "tour" && (
            <Button variant="ghost" size="sm" onClick={() => void done()}>
              Skip
            </Button>
          )}
        </header>
        <div className="mb-3 flex gap-1.5" aria-hidden="true">
          {STEPS.map((s, n) => (
            <span
              key={s}
              className={
                n <= i
                  ? "h-1.5 flex-1 rounded-full bg-accent-600"
                  : "h-1.5 flex-1 rounded-full bg-slate-200 dark:bg-slate-800"
              }
            />
          ))}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-lg shadow-accent-900/5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
          <ErrorText>{error}</ErrorText>
          {step === "profile" && (
            <>
              <Heading title={`Welcome aboard, ${user.displayName.split(" ")[0]}`}>
                This Shipmate has a crew of AI helpers shared by your household. Tell them a little
                about yourself so you never have to repeat it. Everything here is optional.
              </Heading>
              <ProfileStep onNext={next} />
            </>
          )}
          {step === "notifications" && (
            <>
              <Heading title="Make it yours">
                Pick a look and turn on notifications on this device, so you hear back when a crew
                member finishes or needs your OK.
              </Heading>
              <div className="space-y-4">
                <AppearanceSettings />
                <PushSettings />
              </div>
              <Footer>
                <Button variant="primary" onClick={next}>
                  Next
                </Button>
              </Footer>
            </>
          )}
          {step === "tour" && (
            <>
              <Heading title="Here's the ship">
                Pick a place to start, or head to the Bridge and say hello to the Captain.
              </Heading>
              <TourGrid onGo={(path) => void done(path)} />
              <Footer>
                <Button variant="primary" onClick={() => void done()}>
                  Go to the Bridge
                </Button>
              </Footer>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{children}</p>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="mt-8 flex justify-end gap-2 border-t border-slate-200 pt-5 dark:border-slate-800">
      {children}
    </div>
  );
}

function ProfileStep({ onNext }: { onNext: () => void }) {
  const data = useResource(() => api.getProfile());
  if (data.error) return <ErrorText>{data.error}</ErrorText>;
  if (!data.data) return <Loading />;
  return <ProfileForm initial={data.data.profile} onNext={onNext} />;
}

function ProfileForm({ initial, onNext }: { initial: ProfileDto; onNext: () => void }) {
  const [p, setP] = useState({ ...initial, timezone: initial.timezone || browserTimeZone() || "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ProfileDto>(k: K, v: ProfileDto[K]) =>
    setP((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile({
        diet: p.diet,
        budget: p.budget,
        timezone: p.timezone.trim(),
        schedule: p.schedule,
        notes: p.notes,
        shared: p.shared,
      });
      onNext();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Diet and allergies"
            placeholder="e.g. vegetarian, no peanuts"
            maxLength={500}
            value={p.diet}
            onChange={(e) => set("diet", e.target.value)}
          />
          <TextField
            label="Timezone"
            placeholder="e.g. Europe/Berlin"
            maxLength={64}
            value={p.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </div>
        <TextAreaField
          label="Schedule"
          rows={2}
          maxLength={2000}
          placeholder="Work or school hours, activities, routines"
          value={p.schedule}
          onChange={(e) => set("schedule", e.target.value)}
        />
        <TextAreaField
          label="Anything else"
          rows={2}
          maxLength={2000}
          placeholder="How you like replies, favorite stores, …"
          value={p.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </div>
      <ErrorText>{error}</ErrorText>
      <Footer>
        <Button variant="secondary" onClick={onNext} disabled={busy}>
          Skip
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Next"}
        </Button>
      </Footer>
    </>
  );
}
