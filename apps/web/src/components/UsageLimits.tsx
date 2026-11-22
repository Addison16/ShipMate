import type { LimitWindowDto, ProviderLimitDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { formatCents, formatCost } from "../lib/format.js";
import { useResource } from "../lib/useResource.js";
import { Badge, Button, Card, cx, ErrorText } from "./ui.js";

const fill = {
  ok: "bg-emerald-600 dark:bg-emerald-500",
  warning: "bg-amber-500 dark:bg-amber-400",
  limited: "bg-red-600 dark:bg-red-500",
  unknown: "bg-slate-400",
} as const;

const statusBadge: Record<
  ProviderLimitDto["status"],
  { tone: "ok" | "warn" | "danger" | "neutral"; label: string }
> = {
  ok: { tone: "ok", label: "OK" },
  warning: { tone: "warn", label: "Close to limit" },
  limited: { tone: "danger", label: "Limit reached" },
  unknown: { tone: "neutral", label: "Not known yet" },
};

/** "resets 3:40 PM", "resets Tue 9:00 AM" (more than a day away), in the viewer's time zone. */
export function resetLabel(iso: string | null, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (at.getTime() - now.getTime() < 20 * 3600_000) return `resets ${time}`;
  return `resets ${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function windowTone(w: LimitWindowDto): keyof typeof fill {
  if (w.used === null) return "unknown";
  return w.used >= 1 ? "limited" : w.used >= 0.8 ? "warning" : "ok";
}

function Bar({ w }: { w: LimitWindowDto }) {
  const pct = w.used === null ? null : Math.round(w.used * 100);
  const reset = resetLabel(w.resetsAt);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-200">{w.label}</span>
        <span className="tabular-nums text-slate-500 dark:text-slate-400">
          {pct === null ? "" : `${pct}% used`}
          {pct !== null && reset ? " · " : ""}
          {reset}
        </span>
      </div>
      {pct !== null && (
        <div
          className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          aria-hidden="true"
        >
          <div
            className={cx("h-full rounded-full", fill[windowTone(w)])}
            style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function LimitRow({
  limit,
  onChecked,
}: {
  limit: ProviderLimitDto;
  onChecked: (l: ProviderLimitDto) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge =
    limit.kind === "api"
      ? { tone: "neutral" as const, label: "Pay as you go" }
      : limit.kind === "local"
        ? { tone: "neutral" as const, label: "No limits" }
        : statusBadge[limit.status];

  async function check() {
    setChecking(true);
    setError(null);
    try {
      onChecked((await api.checkLimit(limit.id)).limit);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{limit.name}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        {limit.canCheck && (
          <Button size="sm" variant="ghost" disabled={checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check"}
          </Button>
        )}
      </div>
      {limit.windows.map((w) => (
        <Bar key={w.label} w={w} />
      ))}
      {limit.kind === "api" && limit.spentMicroUsd !== null && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {formatCost(limit.spentMicroUsd)} this month, everyone together
        </p>
      )}
      {limit.note && <p className="text-xs text-slate-500 dark:text-slate-400">{limit.note}</p>}
      <ErrorText>{error}</ErrorText>
    </li>
  );
}

/** Usage limits per provider: plan limits, pay-as-you-go spend, and the person's own cap. */
export function UsageLimits() {
  const limits = useResource(() => api.limits());
  const [list, setList] = useState<ProviderLimitDto[] | null>(null);
  useEffect(() => {
    if (limits.data) setList(limits.data.limits);
  }, [limits.data]);
  const me = limits.data?.me;
  if (limits.error) return <ErrorText>{limits.error}</ErrorText>;
  if (!list || !me) return null;
  const capMicro = me.capCents === null ? null : me.capCents * 10_000;
  const capShare =
    capMicro === null ? null : capMicro <= 0 ? 1 : Math.min(1, me.spentMicroUsd / capMicro);

  return (
    <Card>
      <h2 className="font-semibold">Usage limits</h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Read from each provider's own app. Nothing is used up to check.
      </p>
      {capShare !== null && me.capCents !== null && (
        <div className="mb-3 border-b border-slate-200 pb-3 dark:border-slate-700">
          <Bar
            w={{
              label: `Your monthly cap: ${formatCost(me.spentMicroUsd)} of ${formatCents(me.capCents)}`,
              used: capShare,
              resetsAt: null,
            }}
          />
        </div>
      )}
      {list.length ? (
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {list.map((l) => (
            <LimitRow
              key={l.id}
              limit={l}
              onChecked={(fresh) =>
                setList((all) => all?.map((x) => (x.id === fresh.id ? fresh : x)) ?? null)
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">No providers set up yet.</p>
      )}
    </Card>
  );
}
