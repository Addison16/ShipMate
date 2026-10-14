import "../pets.css";
import type { CrewDto, PetDto, PetPreviewMeta } from "@shipmate/core";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { type DockPet, type PetMood, petBuildPrompt, petPhase, petsApi } from "../lib/pets.js";
import { navigate } from "../router.js";
import { setDraft } from "./CrewChat.js";
import { Button, Card, cx, ErrorText, focusRing } from "./ui.js";

/**
 * One pet: its picture over a soft shadow, moving to its mood. Tapping it makes it hop and
 * shows its name, when `tappable`.
 */
export function PetSprite({
  pet,
  crewName,
  mood,
  size,
  tappable,
  className,
}: {
  pet: Pick<PetDto, "name" | "url">;
  crewName: string;
  mood: PetMood;
  /** Pixels. */
  size: number;
  tappable?: boolean;
  className?: string;
}) {
  const [tapped, setTapped] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!tapped) return;
    const t = setTimeout(() => setTapped(0), 1600);
    return () => clearTimeout(t);
  }, [tapped]);
  if (failed) return null;
  const shown: PetMood = tapped ? "happy" : mood;
  const label = `${pet.name}, ${crewName}'s pet${mood === "working" ? ", dancing while they work" : ""}`;
  // Pets start at different points of their loop so several of them don't move in lockstep.
  const style = {
    width: size,
    height: size,
    "--pet-delay": `-${(petPhase(pet.name) * 9).toFixed(2)}s`,
  } as CSSProperties;
  const body = (
    <>
      <span className="pet-shadow" aria-hidden="true" />
      <img
        // A new key restarts the animation when the mood changes or the pet is tapped again.
        key={`${shown}-${tapped}`}
        src={pet.url}
        alt=""
        draggable={false}
        className="pet-body"
        style={shown === "idle" ? { animationDelay: "var(--pet-delay)" } : undefined}
        onError={() => setFailed(true)}
      />
      {tapped > 0 && (
        <span
          aria-hidden="true"
          className="pet-name pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-white shadow-sm dark:bg-white dark:text-slate-900"
        >
          {pet.name}
        </span>
      )}
    </>
  );
  const placed = /\b(absolute|fixed)\b/.test(className ?? "");
  const classes = cx(
    "pet inline-block shrink-0",
    `pet-${shown}`,
    placed ? undefined : "relative",
    className,
  );
  return tappable ? (
    <button
      type="button"
      aria-label={`${label}. Tap to say hi.`}
      title={pet.name}
      onClick={() => setTapped((n) => n + 1)}
      className={cx(classes, "rounded-full", focusRing)}
      style={style}
    >
      {body}
    </button>
  ) : (
    <span role="img" aria-label={label} className={classes} style={style}>
      {body}
    </span>
  );
}

/**
 * Pets sitting on top of the message box: they hang out, dance while their crew member works,
 * and hop once when the reply lands.
 */
export function PetDock({ pets, className }: { pets: DockPet[]; className?: string }) {
  const [happy, setHappy] = useState<Set<string>>(new Set());
  const working = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const now = new Set(pets.filter((p) => p.working).map((p) => p.slug));
    for (const slug of working.current) {
      if (now.has(slug)) continue;
      setHappy((h) => new Set(h).add(slug));
      clearTimeout(timers.current.get(slug));
      timers.current.set(
        slug,
        setTimeout(
          () =>
            setHappy((h) => {
              const next = new Set(h);
              next.delete(slug);
              return next;
            }),
          1200,
        ),
      );
    }
    working.current = now;
  }, [pets]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  if (!pets.length) return null;
  return (
    <div className={cx("pointer-events-none flex items-end gap-1", className)}>
      {pets.map((p) => (
        <PetSprite
          key={p.slug}
          pet={p.pet}
          crewName={p.crewName}
          mood={p.working ? "working" : happy.has(p.slug) ? "happy" : "idle"}
          size={44}
          tappable
          className="pointer-events-auto sm:size-[52px]!"
        />
      ))}
    </div>
  );
}

/** A pet the Captain just made, shown in the conversation above the Keep it question. */
export function PetPreviewCard({ preview }: { preview: PetPreviewMeta }) {
  return (
    <div className="mx-auto flex w-full max-w-md animate-scale-in items-center gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="grid size-28 shrink-0 place-items-center rounded-xl bg-gradient-to-b from-accent-50 to-slate-50 dark:from-accent-950/60 dark:to-slate-900">
        <PetSprite pet={preview} crewName={preview.crew.name} mood="working" size={88} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-600 dark:text-slate-300">{preview.crew.name}'s new pet</p>
        <p className="mt-0.5 truncate text-lg font-semibold">{preview.name}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Hangs out in chat and dances while {preview.crew.name} works.
        </p>
      </div>
    </div>
  );
}

/** Open a new chat with the Captain with the pet build request typed in, ready to send. */
export async function startPetBuild(crewName: string, again: boolean): Promise<void> {
  const { conversation } = await api.createConversation({ kind: "bridge" });
  setDraft(conversation.id, petBuildPrompt(crewName, again));
  navigate(`/bridge/${conversation.id}`);
}

/** Crew → Settings: the crew member's pet, a switch to show it, and making a new one. */
export function CrewPetCard({
  crew,
  captainName,
  admin,
  onSaved,
}: {
  crew: CrewDto;
  captainName: string;
  admin: boolean;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pet = crew.pet;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await petsApi.setShown(crew.slug, enabled);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function build(again: boolean) {
    setBusy(true);
    setError(null);
    try {
      await startPetBuild(crew.name, again);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-4">
        <div className="grid size-16 shrink-0 place-items-center rounded-xl bg-slate-50 dark:bg-slate-800/60">
          {pet?.shown ? (
            <PetSprite pet={pet} crewName={crew.name} mood="idle" size={56} tappable />
          ) : pet ? (
            <img src={pet.url} alt="" className="size-12 object-contain opacity-40 grayscale" />
          ) : (
            <PawGlyph />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{pet ? pet.name : "Pet"}</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {pet?.shown
              ? `Hangs out in chat and dances while ${crew.name} works.`
              : pet
                ? "Hidden for now."
                : `Optional: a little creature that hangs out with ${crew.name} in chat.`}
          </p>
        </div>
        {admin && pet && (
          <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={pet.shown}
              disabled={busy}
              onChange={(e) => void toggle(e.target.checked)}
              className="size-5 accent-accent-700"
            />
            Show
          </label>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {admin && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant={pet ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => void build(Boolean(pet))}
          >
            {pet ? "Make a new pet" : `Make a pet with ${captainName}`}
          </Button>
          <details className="w-full text-sm sm:w-auto">
            <summary
              className={cx(
                "cursor-pointer rounded font-medium text-slate-600 dark:text-slate-300",
                focusRing,
              )}
            >
              More details
            </summary>
            <p className="mt-2 max-w-xl text-xs text-slate-500 dark:text-slate-400">
              {captainName} asks a few quick questions (creature, style and name), then shows you
              the pet to keep or redo. Pictures come from the image model picked under Settings,
              Photos and voice. Without one, {captainName} draws the pet itself, so it always works.
              Pets keep still when your device asks for reduced motion.
            </p>
          </details>
        </div>
      )}
    </Card>
  );
}

function PawGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-7 text-slate-400 dark:text-slate-500"
      fill="currentColor"
      aria-hidden="true"
    >
      <ellipse cx="6" cy="10" rx="2.2" ry="2.8" />
      <ellipse cx="10" cy="6.5" rx="2.2" ry="2.8" />
      <ellipse cx="14" cy="6.5" rx="2.2" ry="2.8" />
      <ellipse cx="18" cy="10" rx="2.2" ry="2.8" />
      <path d="M12 11.5c-3 0-5.5 3.2-5.5 5.6 0 1.8 1.4 2.6 3 2.6 1 0 1.6-.5 2.5-.5s1.5.5 2.5.5c1.6 0 3-.8 3-2.6 0-2.4-2.5-5.6-5.5-5.6Z" />
    </svg>
  );
}
