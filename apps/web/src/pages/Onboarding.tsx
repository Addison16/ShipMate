import type {
  CaptainSetupDto,
  ClaudeCliStatusDto,
  InstallStartersResponse,
  OnboardingStep,
  ProjectDto,
  ShipmateUse,
} from "@shipmate/core";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import { AppearanceSettings } from "../components/AppearanceSettings.js";
import { Avatar } from "../components/Avatar.js";
import { ChatGptCard } from "../components/ChatGptCard.js";
import { ClaudeCliCard } from "../components/ClaudeCliCard.js";
import { NavIcon } from "../components/icons.js";
import { LocalAiCard } from "../components/LocalAiCard.js";
import { Logo } from "../components/Logo.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { PushSettings } from "../components/PushSettings.js";
import { StarterCrewPicker } from "../components/StarterCrewPicker.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { BRIDGE_TABS, type BridgeTab } from "../lib/bridges.js";
import { claudeCliApi, readBackend, withBackend } from "../lib/claude-cli.js";
import {
  GUIDE_STEPS,
  nextStep,
  previousStep,
  stepPosition,
  stepState,
  TOUR_STOPS,
  USE_CHOICES,
} from "../lib/onboarding.js";
import { browserTimeZone } from "../lib/starters.js";
import { useResource } from "../lib/useResource.js";
import { navigate } from "../router.js";
import { DiscordPanel } from "./Discord.js";
import { AddProvider } from "./Providers.js";
import { NewProjectForm } from "./Shipyard.js";
import { SlackPanel } from "./Slack.js";
import { TelegramPanel } from "./Telegram.js";

/**
 * The owner's first-launch guide: the owner account, then a skippable step for each part of a
 * useful Shipmate (a model, the Captain, home facts, starter crew, notifications and chat apps,
 * the Shipyard) and a closing tour. Every step saves as it goes and the server remembers the
 * current step, so closing the tab or signing out picks up where it stopped.
 */
export function OnboardingPage() {
  const { user, onboarding, setOnboarding, refresh } = useAuth();
  const [step, setStep] = useState<OnboardingStep>(
    user ? (onboarding?.step ?? "purpose") : "account",
  );
  const [error, setError] = useState<string | null>(null);

  // Signing in mid-guide (or finishing the account step) brings the saved position.
  useEffect(() => {
    if (user && onboarding && step === "account") setStep(onboarding.step);
  }, [user, onboarding, step]);

  // One guide update at a time: each is a read-modify-write of the saved state on the server.
  const moving = useRef(false);

  async function go(
    to: OnboardingStep,
    mark?: { done?: OnboardingStep; skipped?: OnboardingStep },
  ) {
    if (moving.current) return;
    moving.current = true;
    setError(null);
    try {
      // Move only once the server has the new position, so a reload never jumps backward.
      const { onboarding: next } = await api.updateOnboarding({ step: to, ...mark });
      setOnboarding(next);
      setStep(to);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      moving.current = false;
    }
  }

  const advance = (done: boolean) => go(nextStep(step), done ? { done: step } : { skipped: step });
  const back = previousStep(step);

  async function finish(path = "/bridge") {
    setError(null);
    try {
      navigate(path);
      const { onboarding: next } = await api.updateOnboarding({ finish: true });
      setOnboarding(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const nav: StepNav = {
    next: () => void advance(true),
    skip: () => void advance(false),
    back: back ? () => void go(back) : null,
  };

  return (
    <GuideLayout
      step={step}
      onLeave={
        user
          ? () => {
              if (
                window.confirm(
                  "Skip the rest of the setup guide? You can run it again from Settings.",
                )
              ) {
                void finish();
              }
            }
          : null
      }
    >
      <ErrorText>{error}</ErrorText>
      {step === "account" && <AccountStep onCreated={refresh} />}
      {step === "purpose" && <PurposeStep nav={nav} />}
      {step === "model" && <ModelStep nav={nav} />}
      {step === "captain" && <CaptainStep nav={nav} />}
      {step === "household" && <HouseholdStep nav={nav} />}
      {step === "crew" && <CrewStep nav={nav} />}
      {step === "connect" && <ConnectStep nav={nav} />}
      {step === "shipyard" && <ShipyardStep nav={nav} />}
      {step === "finish" && <FinishStep onGo={(path) => void finish(path)} onBack={nav.back} />}
    </GuideLayout>
  );
}

// ---------- layout ----------

interface StepNav {
  next: () => void;
  skip: () => void;
  back: (() => void) | null;
}

function GuideLayout({
  step,
  onLeave,
  children,
}: {
  step: OnboardingStep;
  onLeave: (() => void) | null;
  children: ReactNode;
}) {
  const { onboarding } = useAuth();
  const { n, of } = stepPosition(step);
  const tour = step === "finish";
  return (
    <main className="min-h-dvh bg-gradient-to-b from-accent-50 to-slate-50 px-4 py-6 sm:py-10 dark:from-accent-950/40 dark:to-slate-950">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-slate-900 dark:text-white">
            <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm">
              <Logo size={22} />
            </span>
            <span className="text-xl font-semibold tracking-tight">Shipmate</span>
          </div>
          {onLeave && !tour && (
            <Button variant="ghost" size="sm" onClick={onLeave}>
              Skip the rest
            </Button>
          )}
        </header>

        <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
          <nav aria-label="Setup steps" className="hidden lg:block">
            <ol className="space-y-1">
              {GUIDE_STEPS.map((s, i) => {
                const state = stepState(s.id, step, onboarding);
                return (
                  <li
                    key={s.id}
                    aria-current={state === "current" ? "step" : undefined}
                    className={cx(
                      "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
                      state === "current"
                        ? "bg-white font-medium text-accent-800 shadow-sm dark:bg-slate-900 dark:text-accent-200"
                        : "text-slate-600 dark:text-slate-400",
                    )}
                  >
                    <span
                      className={cx(
                        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                        state === "done" && "bg-accent-700 text-white dark:bg-accent-600",
                        state === "current" &&
                          "border-2 border-accent-700 text-accent-800 dark:border-accent-400 dark:text-accent-200",
                        state === "skipped" &&
                          "border border-dashed border-slate-400 text-slate-500 dark:border-slate-600",
                        state === "todo" &&
                          "border border-slate-300 text-slate-500 dark:border-slate-700",
                      )}
                    >
                      {state === "done" ? <NavIcon name="check" size={14} /> : i + 1}
                    </span>
                    <span>{s.label}</span>
                    {state === "skipped" && <span className="sr-only">(skipped)</span>}
                  </li>
                );
              })}
            </ol>
          </nav>

          <div className="min-w-0">
            {!tour && (
              <div className="mb-3 lg:hidden">
                <div className="mb-1 flex justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                  <span>
                    Step {n} of {of}
                  </span>
                  <span>{GUIDE_STEPS.find((s) => s.id === step)?.label}</span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
                  role="progressbar"
                  aria-label="Setup progress"
                  aria-valuemin={1}
                  aria-valuemax={of}
                  aria-valuenow={n}
                >
                  <div
                    className="h-full rounded-full bg-accent-600 transition-all"
                    style={{ width: `${(n / of) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-lg shadow-accent-900/5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
              {children}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function StepHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {eyebrow && (
        <p className="mb-1 text-xs font-semibold tracking-wide text-accent-700 uppercase dark:text-accent-300">
          {eyebrow}
        </p>
      )}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children && (
        <div className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">{children}</div>
      )}
    </div>
  );
}

/** Back, Skip and the primary action along the bottom of a step. */
function StepFooter({
  nav,
  nextLabel = "Next",
  onNext,
  busy,
  canSkip = true,
}: {
  nav: StepNav;
  nextLabel?: string;
  /** Runs before moving on (to save the step); throwing keeps the step open. */
  onNext?: () => Promise<void> | void;
  busy?: boolean;
  canSkip?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function next() {
    setSaving(true);
    setError(null);
    try {
      await onNext?.();
      nav.next();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-8 border-t border-slate-200 pt-5 dark:border-slate-800">
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        {nav.back && (
          <Button variant="ghost" onClick={nav.back} disabled={saving}>
            Back
          </Button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {canSkip && (
            <Button variant="secondary" onClick={nav.skip} disabled={saving}>
              Skip for now
            </Button>
          )}
          <Button variant="primary" onClick={() => void next()} disabled={saving || busy}>
            {saving ? "Saving…" : nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A big selectable card, used for picking a provider route or the Captain's voice. */
function ChoiceCard({
  selected,
  onSelect,
  title,
  badge,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        "flex h-full flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors",
        focusRing,
        selected
          ? "border-accent-600 bg-accent-50 ring-1 ring-accent-600 dark:border-accent-400 dark:bg-accent-950/40 dark:ring-accent-400"
          : "border-slate-200 hover:border-accent-300 dark:border-slate-700 dark:hover:border-accent-700",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        {badge}
      </span>
      <span className="text-sm text-slate-600 dark:text-slate-400">{children}</span>
    </button>
  );
}

// ---------- 1. account ----------

function AccountStep({ onCreated }: { onCreated: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setup({ email: email.trim(), displayName: displayName.trim(), password });
      // Signs in and loads the guide's saved position (the model step).
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <StepHeader eyebrow="Welcome aboard" title="Create the owner account">
        Shipmate is your own crew of AI helpers for everyday life and work, running on your
        hardware. This account owns the instance; you can add the rest of the household later. The
        next few steps take about five minutes and every one can be skipped.
      </StepHeader>
      <form onSubmit={submit} className="max-w-md space-y-4">
        <TextField
          label="Your name"
          autoComplete="name"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Setting up…" : "Create account and continue"}
        </Button>
      </form>
    </>
  );
}

// ---------- 2. purpose ----------

type Use = ShipmateUse | "";

/** What Shipmate is for, as saved on the purpose step ("" when skipped). */
function useShipmateUse() {
  return useResource(() => api.getProfile().then((r) => r.household.use));
}

function PurposeStep({ nav }: { nav: StepNav }) {
  const use = useShipmateUse();
  return (
    <>
      <StepHeader eyebrow="First things first" title="What will you use Shipmate for?">
        This decides what the guide asks next and which crew members it suggests. You can change it
        later in Settings.
      </StepHeader>
      <ErrorText>{use.error}</ErrorText>
      {use.loading && use.data === null && <Muted>Loading…</Muted>}
      {use.data !== null && <PurposeForm initial={use.data} nav={nav} />}
    </>
  );
}

function PurposeForm({ initial, nav }: { initial: Use; nav: StepNav }) {
  const [use, setUse] = useState<Use>(initial);

  async function save() {
    if (!use) throw new Error("Pick one, or skip this for now.");
    if (use !== initial) await api.updateHousehold({ use });
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {USE_CHOICES.map((c) => (
          <ChoiceCard
            key={c.id}
            selected={use === c.id}
            onSelect={() => setUse(c.id)}
            title={c.title}
          >
            {c.body}
          </ChoiceCard>
        ))}
      </div>
      <StepFooter nav={nav} onNext={save} />
    </>
  );
}

// ---------- 3. model ----------

const CAPTAIN = "captain";

type ModelRoute = "local" | "chatgpt" | "claude" | "key";

function ModelStep({ nav }: { nav: StepNav }) {
  const models = useResource(() => api.listModels().then((r) => r.models));
  const providers = useResource(() => api.listProviders());
  const settings = useResource(() => api.getSettings());
  const [route, setRoute] = useState<ModelRoute | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // The Claude subscription is not a provider: it runs crew members through the official CLI.
  const cliStatus = useResource(() => claudeCliApi.status().then((r) => r.claudeCli));
  const [cli, setCli] = useState<ClaudeCliStatusDto | null>(null);
  const cliReady = !!(cli ?? cliStatus.data)?.signedIn;
  const captain = useResource(() => api.getCrew(CAPTAIN).then((r) => r.crew));
  const captainOnCli = captain.data
    ? readBackend(captain.data.manifestYaml) === "claude-code-cli"
    : false;
  const [useCli, setUseCli] = useState<boolean | null>(null);
  const available = models.data?.filter((m) => m.available) ?? [];
  const current = defaultModel ?? settings.data?.defaultModel ?? "";
  // Default to Claude when it is signed in and nothing else is, or the Captain already uses it.
  const onCli = cliReady && (useCli ?? (captainOnCli || available.length === 0));
  const ready = available.length > 0 || onCli;
  const kinds = (providers.data?.kinds ?? []).filter(
    (k) => k.kind !== "openai-chatgpt" && k.kind !== "claude-code-cli",
  );

  const reload = async () => {
    await Promise.all([models.reload(), providers.reload(), settings.reload()]);
    setDefaultModel(null);
  };

  async function save() {
    if (!ready) return;
    // Read the Captain fresh, so a slow or failed load never skips the switch silently.
    const { crew: skipper } = await api.getCrew(CAPTAIN);
    const isCli = readBackend(skipper.manifestYaml) === "claude-code-cli";
    if (onCli !== isCli) {
      const backend = onCli ? "claude-code-cli" : "pi";
      await api.updateCrew(CAPTAIN, { manifestYaml: withBackend(skipper.manifestYaml, backend) });
    }
    if (available.length === 0) return;
    // Point the crew's default at a model that works; keep the owner's pick when it does.
    const usable = available.some((m) => m.ref === current) ? current : available[0]?.ref;
    if (usable && usable !== settings.data?.defaultModel) {
      await api.updateSettings({ defaultModel: usable });
    }
  }

  return (
    <>
      <StepHeader eyebrow="Give the crew a brain" title="Connect an AI model">
        The crew thinks with a language model. Pick how you want to run it. You can add more later
        on the Providers page, and each crew member can use a different one.
      </StepHeader>

      {available.length > 0 && (
        <div className="mb-5">
          <Notice>
            {available.length} model{available.length === 1 ? " is" : "s are"} ready. Add another or
            move on.
          </Notice>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceCard
          selected={route === "local"}
          onSelect={() => setRoute("local")}
          title="Run it here"
          badge={<Badge tone="ok">free, private</Badge>}
        >
          Download an open model with Ollama. Nothing leaves your network; needs a decent CPU or
          GPU.
        </ChoiceCard>
        <ChoiceCard
          selected={route === "chatgpt"}
          onSelect={() => setRoute("chatgpt")}
          title="ChatGPT plan"
        >
          Sign in with your ChatGPT Plus or Pro account and use the plan you already pay for.
        </ChoiceCard>
        <ChoiceCard
          selected={route === "claude"}
          onSelect={() => setRoute("claude")}
          title="Claude subscription"
        >
          Use your Claude Pro or Max plan through the official Claude Code sign-in.
        </ChoiceCard>
        <ChoiceCard
          selected={route === "key"}
          onSelect={() => setRoute("key")}
          title="API key"
          badge={<Badge>pay as you go</Badge>}
        >
          Anthropic, OpenAI, OpenRouter, Google and others. Billed per use by the provider.
        </ChoiceCard>
      </div>

      <div className="mt-5">
        {route === "local" && <LocalAiCard onUsed={() => void reload()} />}
        {route === "chatgpt" && <ChatGptCard onChanged={reload} />}
        {route === "claude" && (
          <div className="space-y-3">
            <ClaudeCliCard onStatus={setCli} />
          </div>
        )}
        {route === "key" && providers.data && <AddProvider kinds={kinds} onAdded={reload} />}
      </div>

      {cliReady && (
        <label className="mt-5 flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-700">
          <input
            type="checkbox"
            checked={onCli}
            onChange={(e) => setUseCli(e.target.checked)}
            className="mt-0.5 size-4 accent-accent-700"
          />
          <span>
            <span className="block font-medium">Run the Captain on your Claude subscription</span>
            <span className="block text-slate-600 dark:text-slate-400">
              Claude Code is signed in. The Captain will answer through it, and so will the starter
              crew you bring aboard next. On Claude Code the Captain chats and uses its own tools,
              but cannot hand work to other crew members; add a provider too for that.
            </span>
          </span>
        </label>
      )}

      {available.length > 0 && (
        <div className="mt-5 max-w-md">
          <ModelSelect
            label="Default model for the crew"
            value={available.some((m) => m.ref === current) ? current : (available[0]?.ref ?? "")}
            onChange={setDefaultModel}
            models={available}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            The Captain and new crew members use this until you choose otherwise.
          </p>
        </div>
      )}

      <StepFooter
        nav={ready ? nav : { ...nav, next: nav.skip }}
        onNext={save}
        busy={models.loading}
        nextLabel={ready ? "Next" : "Next without a model"}
        canSkip={false}
      />
      {!ready && (
        <p className="mt-2 text-right text-xs text-slate-500 dark:text-slate-400">
          The crew cannot answer until a model is connected.
        </p>
      )}
    </>
  );
}

// ---------- 4. captain ----------

function CaptainStep({ nav }: { nav: StepNav }) {
  const setup = useResource(() => api.captainSetup());
  const use = useShipmateUse();
  const data = setup.data;
  return (
    <>
      <StepHeader eyebrow="Meet your coordinator" title="Name your Captain">
        The Captain is the one you talk to on the Bridge. It answers quick questions itself and
        hands bigger jobs to the rest of the crew.
      </StepHeader>
      <ErrorText>{setup.error}</ErrorText>
      {setup.loading && !data && <Muted>Loading…</Muted>}
      {data && (
        <CaptainForm
          key={data.name + data.voice}
          initial={data}
          work={use.data === "work"}
          nav={nav}
        />
      )}
    </>
  );
}

function CaptainForm({
  initial,
  work,
  nav,
}: {
  initial: CaptainSetupDto;
  /** Preview a work question instead of a home one. */
  work: boolean;
  nav: StepNav;
}) {
  const [name, setName] = useState(initial.name);
  const [voiceId, setVoiceId] = useState(initial.voiceId);
  const [custom, setCustom] = useState(initial.voiceId === "custom" ? initial.voice : "");
  const preset = initial.voices.find((v) => v.id === voiceId);
  const shownName = name.trim() || "Captain";

  async function save() {
    const voice = voiceId === "custom" ? custom.trim() : voiceId;
    if (!voice) throw new Error("Describe how the Captain should talk, or pick a preset.");
    await api.updateCaptainSetup({ name: name.trim() || "Captain", voice });
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          <TextField
            label="Name"
            maxLength={60}
            className="max-w-sm"
            hint="Captain, Skipper, Jeeves, Hal… You can rename it any time in Settings."
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Personality</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {initial.voices.map((v) => (
                <ChoiceCard
                  key={v.id}
                  selected={voiceId === v.id}
                  onSelect={() => setVoiceId(v.id)}
                  title={v.label}
                >
                  {v.blurb}
                </ChoiceCard>
              ))}
              <ChoiceCard
                selected={voiceId === "custom"}
                onSelect={() => setVoiceId("custom")}
                title="Write my own"
              >
                Describe the tone in your own words.
              </ChoiceCard>
            </div>
          </fieldset>
          {voiceId === "custom" && (
            <TextAreaField
              label="How should the Captain talk?"
              rows={4}
              maxLength={2000}
              placeholder="e.g. Friendly and brief. Use metric units. Reply in Spanish when I write in Spanish."
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          )}
        </div>
        <aside aria-label="Preview" className="self-start">
          <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Preview
          </p>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/50">
            <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent-700 px-3 py-2 text-sm text-white">
              {work ? "What's on my plate today?" : "What's for dinner tonight?"}
            </div>
            <div className="flex items-start gap-2">
              <Avatar name={shownName} size="sm" />
              <div>
                <p className="mb-0.5 text-xs font-medium">{shownName}</p>
                <div className="rounded-2xl rounded-tl-sm bg-white px-3 py-2 text-sm shadow-sm dark:bg-slate-800">
                  {(work ? preset?.workSample : preset?.sample) ??
                    (custom.trim() ? "(answers in the voice you describe)" : "…")}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
      <StepFooter nav={nav} onNext={save} />
    </>
  );
}

// ---------- 5. household ----------

function HouseholdStep({ nav }: { nav: StepNav }) {
  const data = useResource(() => api.getProfile());
  const work = data.data?.household.use === "work";
  return (
    <>
      <StepHeader eyebrow="So nobody asks twice" title="A few basics">
        {work
          ? "Where you're based and when you work, so reminders and briefings land at the right time. All of it is optional and stays on your server."
          : "Your town and timezone are enough to start. Every crew member reads this, and all of it is optional and stays on your server."}
      </StepHeader>
      <ErrorText>{data.error}</ErrorText>
      {data.loading && !data.data && <Muted>Loading…</Muted>}
      {data.data && <HouseholdForm initial={data.data} nav={nav} />}
    </>
  );
}

function HouseholdForm({
  initial,
  nav,
}: {
  initial: Awaited<ReturnType<typeof api.getProfile>>;
  nav: StepNav;
}) {
  const use = initial.household.use;
  const work = use === "work";
  const tz = browserTimeZone() ?? "";
  const [location, setLocation] = useState(initial.household.location);
  const [timezone, setTimezone] = useState(initial.household.timezone || tz);
  const [notes, setNotes] = useState(initial.household.notes);
  const [diet, setDiet] = useState(initial.profile.diet);
  const [schedule, setSchedule] = useState(initial.profile.schedule);
  const [showInvite, setShowInvite] = useState(false);
  // Personal details wait behind a button, so the guide doesn't open with questions about family.
  const [more, setMore] = useState(
    !!(initial.household.notes || initial.profile.diet || initial.profile.schedule),
  );

  async function save() {
    const tzValue = timezone.trim();
    const household = { location: location.trim(), timezone: tzValue, notes };
    const h = initial.household;
    if (household.location !== h.location || tzValue !== h.timezone || notes !== h.notes) {
      await api.updateHousehold(household);
    }
    const p = initial.profile;
    const personalTz = p.timezone || tzValue;
    if (diet !== p.diet || schedule !== p.schedule || personalTz !== p.timezone) {
      await api.updateProfile({
        diet,
        budget: p.budget,
        timezone: personalTz,
        schedule,
        notes: p.notes,
        shared: p.shared,
      });
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={work ? "Where you're based" : "Home town"}
            placeholder="e.g. Austin, TX"
            hint="For the weather and travel."
            maxLength={200}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <TextField
            label="Timezone"
            placeholder="e.g. America/Chicago"
            maxLength={64}
            hint={
              tz && timezone !== tz
                ? `This device says ${tz}.`
                : "Used for reminders and schedules."
            }
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>
        {work ? (
          <TextField
            label="Your working hours"
            placeholder="e.g. 9 to 5 weekdays, no meetings on Fridays"
            maxLength={2000}
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
        ) : more ? (
          <>
            <TextAreaField
              label="Who's aboard"
              rows={3}
              maxLength={4000}
              placeholder="Who lives here, kids' ages, pets, shared routines, house rules"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Your diet and allergies"
                placeholder="e.g. vegetarian, no peanuts"
                maxLength={500}
                value={diet}
                onChange={(e) => setDiet(e.target.value)}
              />
              <TextField
                label="Your schedule"
                placeholder="e.g. work 9 to 5 weekdays, gym Tuesdays"
                maxLength={2000}
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setMore(true)}>
              Add more about {use === "home" ? "your household" : "yourself"}
            </Button>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Optional: who's aboard, diets and allergies, your schedule. You can also add these
              later in Settings.
            </p>
          </div>
        )}
      </div>

      <div className="mt-6 space-y-4">
        <AppearanceSettings />
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                {work
                  ? "Add your team"
                  : use === "home"
                    ? "Add the rest of the household"
                    : "Add other people"}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Everyone shares the crew; each person gets their own conversations and profile.
              </p>
            </div>
            {!showInvite && (
              <Button size="sm" onClick={() => setShowInvite(true)}>
                Add a person
              </Button>
            )}
          </div>
          {showInvite && <InviteForm />}
        </Card>
      </div>
      <StepFooter nav={nav} onNext={save} />
    </>
  );
}

function InviteForm() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.createUser({
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        role,
      });
      setAdded((a) => [...a, `${user.displayName} (${user.email})`]);
      setDisplayName("");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      {added.length > 0 && (
        <ul className="space-y-1 text-sm">
          {added.map((a) => (
            <li
              key={a}
              className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"
            >
              <NavIcon name="check" size={14} /> Added {a}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextField
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Temporary password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="Share it with them; they can change it in Settings."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as "member" | "admin")}
        >
          <option value="member">Member</option>
          <option value="admin">Admin (can manage crew and users)</option>
        </SelectField>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add person"}
      </Button>
    </form>
  );
}

// ---------- 6. crew ----------

function CrewStep({ nav }: { nav: StepNav }) {
  const use = useShipmateUse();
  const [result, setResult] = useState<InstallStartersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // Installed crew still waiting on the move to Claude Code, kept so a failed move can be retried.
  const [pending, setPending] = useState<InstallStartersResponse | null>(null);

  // A Captain on the Claude subscription (picked on the model step) brings its crew along. The
  // roster shows only once every switch is saved, so leaving early never strands one on pi.
  async function installed(r: InstallStartersResponse) {
    setSwitching(true);
    setPending(r);
    setError(null);
    try {
      const { crew: captain } = await api.getCrew(CAPTAIN);
      if (readBackend(captain.manifestYaml) === "claude-code-cli") {
        for (const c of r.crew) {
          const { crew } = await api.getCrew(c.slug);
          if (readBackend(crew.manifestYaml) === "claude-code-cli") continue;
          await api.updateCrew(c.slug, {
            manifestYaml: withBackend(crew.manifestYaml, "claude-code-cli"),
          });
        }
      }
      setResult(r);
      setPending(null);
    } catch (err) {
      setError(`Could not move the new crew to Claude Code: ${errorMessage(err)}`);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <StepHeader eyebrow="Fill the ship" title="Bring aboard a starter crew">
        Ready-made crew members, each with one job and the tools for it. The Captain delegates to
        them. Their scheduled routines start paused so nothing runs until you say so.
      </StepHeader>
      {result ? (
        <>
          <ul className="grid gap-2 sm:grid-cols-2">
            {result.crew.map((c) => (
              <li
                key={c.slug}
                className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <Avatar name={c.name} />
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{c.role}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-2">
            <ErrorText>{error}</ErrorText>
            {result.notes.map((n) => (
              <Notice key={n}>{n}</Notice>
            ))}
          </div>
          <StepFooter nav={nav} canSkip={false} />
        </>
      ) : (
        <>
          {error && (
            <div className="mb-4">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
          {use.data === null && !use.error ? (
            <Muted>Loading…</Muted>
          ) : switching ? (
            <Muted>Moving the new crew to Claude Code…</Muted>
          ) : pending ? (
            <Button onClick={() => void installed(pending)}>Try again</Button>
          ) : (
            <StarterCrewPicker
              doneLabel="Bring aboard"
              onDone={(r) => void installed(r)}
              skipLabel="Skip for now"
              onSkip={nav.skip}
              use={use.data ?? ""}
            />
          )}
          {nav.back && (
            <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-800">
              <Button variant="ghost" onClick={nav.back}>
                Back
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------- 7. connect ----------

function ConnectStep({ nav }: { nav: StepNav }) {
  const [tab, setTab] = useState<BridgeTab | null>(null);
  return (
    <>
      <StepHeader eyebrow="Stay in touch" title="Reach the crew from anywhere">
        Get a ping when a crew member needs your approval or a routine finishes, and chat from the
        apps you already use. Add Shipmate to your phone's home screen for an app-like feel.
      </StepHeader>
      <PushSettings />
      <div className="mt-6">
        <h2 className="font-semibold">Chat apps</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Optional. Each one needs a bot you create in that app; the steps are inside.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {BRIDGE_TABS.map((t) => (
            <ChoiceCard
              key={t.id}
              selected={tab === t.id}
              onSelect={() => setTab(tab === t.id ? null : t.id)}
              title={t.label}
            >
              {t.id === "discord" && "A channel per crew member on your server."}
              {t.id === "telegram" && "Message the crew from a Telegram bot."}
              {t.id === "slack" && "Mention the crew in your workspace."}
            </ChoiceCard>
          ))}
        </div>
        {tab && (
          <div className="mt-4">
            {tab === "discord" && <DiscordPanel />}
            {tab === "telegram" && <TelegramPanel />}
            {tab === "slack" && <SlackPanel />}
          </div>
        )}
      </div>
      <StepFooter nav={nav} />
    </>
  );
}

// ---------- 8. shipyard ----------

function ShipyardStep({ nav }: { nav: StepNav }) {
  const shipyard = useResource(() => api.getShipyard());
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  const [added, setAdded] = useState<ProjectDto[]>([]);
  const [adding, setAdding] = useState(false);
  const status = shipyard.data?.status;

  return (
    <>
      <StepHeader eyebrow="Optional: for code" title="Put the crew to work on GitHub">
        The Shipyard lets a crew member plan features, fix issues and review pull requests on your
        repositories, working in a throwaway sandbox. Skip this if you only want help at home.
      </StepHeader>
      <ErrorText>{shipyard.error ?? crew.error}</ErrorText>
      {status && (
        <div className="mb-5">
          {status.available ? (
            <Notice>Sandboxes are ready ({status.endpoint}).</Notice>
          ) : (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              Sandboxes are not available yet:{" "}
              {status.reason?.replace(/\.+$/, "") ?? "Docker is not reachable"}. You can still add a
              project; mount the Docker socket (see the install guide) before the crew runs code.
            </div>
          )}
        </div>
      )}
      {added.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {added.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"
            >
              <NavIcon name="check" size={14} /> Added {p.name}
            </li>
          ))}
        </ul>
      )}
      {adding && crew.data && shipyard.data ? (
        <Card>
          <NewProjectForm
            crew={crew.data}
            defaultImage={shipyard.data.status.sandboxImage}
            onCreated={(p) => {
              setAdded((a) => [...a, p]);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      ) : (
        <Button onClick={() => setAdding(true)} disabled={!crew.data || !shipyard.data}>
          {added.length ? "Add another project" : "Add a project"}
        </Button>
      )}
      <StepFooter
        nav={added.length ? nav : { ...nav, next: nav.skip }}
        canSkip={false}
        nextLabel={added.length ? "Next" : "Not now"}
      />
    </>
  );
}

// ---------- 9. tour ----------

function FinishStep({
  onGo,
  onBack,
}: {
  onGo: (path: string) => void;
  onBack: (() => void) | null;
}) {
  const { onboarding } = useAuth();
  const settings = useResource(() => api.getSettings());
  const captain = settings.data?.captainName ?? "your Captain";
  const skipped = GUIDE_STEPS.filter((s) => onboarding?.skipped.includes(s.id));
  return (
    <>
      <StepHeader eyebrow="All hands on deck" title="You're ready to sail">
        Here's where everything lives. Pick a place to start, or head to the Bridge and say hello to
        {captain}.
      </StepHeader>
      {skipped.length > 0 && (
        <div className="mb-5">
          <Notice>
            Skipped for now: {skipped.map((s) => s.label).join(", ")}. Run this guide again any time
            from Settings.
          </Notice>
        </div>
      )}
      <TourGrid onGo={onGo} />
      <div className="mt-8 flex items-center border-t border-slate-200 pt-5 dark:border-slate-800">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="primary" className="ml-auto" onClick={() => onGo("/bridge")}>
          Go to the Bridge
        </Button>
      </div>
    </>
  );
}

export function TourGrid({ onGo }: { onGo: (path: string) => void }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {TOUR_STOPS.map((stop) => (
        <li key={stop.path}>
          <button
            type="button"
            onClick={() => onGo(stop.path)}
            className={cx(
              "flex h-full w-full items-start gap-3 rounded-xl border border-slate-200 p-4 text-left transition-colors hover:border-accent-300 hover:bg-accent-50/50 dark:border-slate-800 dark:hover:border-accent-700 dark:hover:bg-accent-950/30",
              focusRing,
            )}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-100 text-accent-800 dark:bg-accent-950 dark:text-accent-200">
              <NavIcon name={stop.icon} size={18} />
            </span>
            <span>
              <span className="block font-semibold">{stop.title}</span>
              <span className="block text-sm text-slate-600 dark:text-slate-400">{stop.body}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
