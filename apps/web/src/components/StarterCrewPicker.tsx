import type { InstallStartersResponse, ShipmateUse, StarterCrewDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useThemeWords } from "../appearance.js";
import { rankStarters } from "../lib/onboarding.js";
import { browserTimeZone, describeSchedule } from "../lib/starters.js";
import { useResource } from "../lib/useResource.js";
import { Avatar } from "./Avatar.js";
import { Badge, Button, cx, ErrorText, Loading, Muted } from "./ui.js";

/**
 * Pick ready-made crew members (Galley, Purser, Navigator, ...) to bring aboard. Used on the
 * first-run setup page and from the Crew page. Starter watches are added paused.
 */
export function StarterCrewPicker({
  onDone,
  doneLabel = "Add to the crew",
  skipLabel,
  onSkip,
  use,
}: {
  onDone: (result: InstallStartersResponse) => void;
  doneLabel?: string;
  skipLabel?: string;
  onSkip?: () => void;
  /** What Shipmate is for: matching crew come first and are picked; the rest are offered after. */
  use?: ShipmateUse | "";
}) {
  const starters = useResource(() => api.listStarters().then((r) => r.starters));
  const words = useThemeWords();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [withWatches, setWithWatches] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-select the suggested crew not aboard yet the first time the list loads.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !starters.data) return;
    const { suggested } = rankStarters(starters.data, use);
    setPicked(new Set(suggested.filter((s) => !s.installed).map((s) => s.slug)));
    setSeeded(true);
  }, [starters.data, seeded, use]);

  function toggle(slug: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const tz = browserTimeZone();
      const result = await api.installStarters({
        slugs: [...picked],
        watches: withWatches,
        ...(tz ? { timezone: tz } : {}),
      });
      onDone(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const list = starters.data ?? [];
  const { suggested, others } = rankStarters(list, use);
  const row = (s: StarterCrewDto) => (
    <StarterRow
      key={s.slug}
      starter={s}
      checked={picked.has(s.slug)}
      onToggle={() => toggle(s.slug)}
    />
  );
  return (
    <div className="space-y-4">
      <ErrorText>{starters.error}</ErrorText>
      {starters.loading && !starters.data && <Loading />}
      {starters.data && list.length === 0 && <Muted>No starter crew in this install.</Muted>}
      <ul className="space-y-2">{suggested.map(row)}</ul>
      {others.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">
            {use === "work" ? "More crew, for home life" : "More crew, for work"}
          </p>
          <ul className="space-y-2">{others.map(row)}</ul>
        </div>
      )}
      {list.some((s) => s.watch && !s.installed) && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={withWatches}
            onChange={(e) => setWithWatches(e.target.checked)}
            className="mt-0.5 size-4 accent-accent-700"
          />
          <span>
            Also add their starter {words.watches.toLowerCase()}, <strong>paused</strong>. Nothing
            runs or spends until you turn one on.
          </span>
        </label>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || picked.size === 0}
          onClick={() => void install()}
        >
          {busy
            ? "Bringing them aboard…"
            : picked.size
              ? `${doneLabel} (${picked.size})`
              : doneLabel}
        </Button>
        {onSkip && (
          <Button variant="ghost" disabled={busy} onClick={onSkip}>
            {skipLabel ?? "Skip"}
          </Button>
        )}
      </div>
    </div>
  );
}

function StarterRow({
  starter,
  checked,
  onToggle,
}: {
  starter: StarterCrewDto;
  checked: boolean;
  onToggle: () => void;
}) {
  const id = `starter-${starter.slug}`;
  // The theme's word for watches, in the singular.
  const watch = useThemeWords().watches.replace(/s$/, "");
  return (
    <li>
      <label
        htmlFor={id}
        className={cx(
          "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
          starter.installed
            ? "cursor-default border-slate-200 opacity-70 dark:border-slate-700"
            : checked
              ? "border-accent-600 bg-accent-50/60 dark:border-accent-400 dark:bg-accent-950/30"
              : "border-slate-200 hover:border-accent-600/50 dark:border-slate-700",
        )}
      >
        <input
          id={id}
          type="checkbox"
          disabled={starter.installed}
          checked={starter.installed || checked}
          onChange={onToggle}
          className="mt-2.5 size-4 accent-accent-700"
        />
        <Avatar name={starter.name} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{starter.name}</span>
            {starter.installed && <Badge tone="ok">aboard</Badge>}
          </span>
          <span className="mt-0.5 block text-sm text-slate-600 dark:text-slate-300">
            {starter.blurb}
          </span>
          {starter.watch && (
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              {watch}: {starter.watch.name} ({describeSchedule(starter.watch.cron)})
            </span>
          )}
          {starter.mcp.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {starter.mcp.map((m) => (
                <Badge key={m}>{m}</Badge>
              ))}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}
