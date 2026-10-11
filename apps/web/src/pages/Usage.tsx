import type { UsageResponse, UsageTotals } from "@shipmate/core";
import { type ReactNode, useState } from "react";
import { api } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import {
  Badge,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Page,
  PageHeader,
  Table,
  TextField,
  td,
  th,
} from "../components/ui.js";
import { currentMonth, formatCents, formatCost, formatTokens } from "../lib/format.js";
import {
  capTone,
  centsToMicro,
  dailyBars,
  formatPercent,
  formatUsdShort,
  percentUsed,
  usageExportUrl,
  usdToMicro,
} from "../lib/usage.js";
import { useResource } from "../lib/useResource.js";
import { href } from "../router.js";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

const num = `${td} text-right tabular-nums`;
const numTh = `${th} text-right`;

function TotalsCells({ t }: { t: UsageTotals }) {
  return (
    <>
      <td className={num}>{formatTokens(t.calls)}</td>
      <td className={num}>{formatTokens(t.inputTokens)}</td>
      <td className={num}>{formatTokens(t.outputTokens)}</td>
      <td className={num}>{formatTokens(t.cacheReadTokens + t.cacheWriteTokens)}</td>
      <td className={num}>{formatCost(t.costMicroUsd)}</td>
    </>
  );
}

function TotalsHead() {
  return (
    <>
      <th className={numTh}>Calls</th>
      <th className={numTh}>Input</th>
      <th className={numTh}>Output</th>
      <th className={numTh}>Cache</th>
      <th className={numTh}>Cost</th>
    </>
  );
}

const meterFill = {
  ok: "bg-emerald-600 dark:bg-emerald-500",
  warn: "bg-amber-500 dark:bg-amber-400",
  danger: "bg-red-600 dark:bg-red-500",
  neutral: "bg-slate-400",
} as const;

/** The cap and how much of it is spent: a small meter, the percent, and a badge when reached. */
function CapCells({
  spent,
  capMicro,
  capLabel,
}: {
  spent: number;
  capMicro: number | null;
  capLabel: string;
}) {
  const p = percentUsed(spent, capMicro);
  const tone = capTone(p);
  return (
    <>
      <td className={num}>{capLabel}</td>
      <td className={`${td} min-w-36`}>
        {p === null ? (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <div
              className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
              aria-hidden="true"
            >
              <div
                className={cx("h-full rounded-full", meterFill[tone])}
                style={{ width: `${Math.min(100, Number.isFinite(p) ? p : 100)}%` }}
              />
            </div>
            <span className="w-12 text-right tabular-nums">{formatPercent(p)}</span>
            {p >= 100 && <Badge tone="danger">reached</Badge>}
          </div>
        )}
      </td>
    </>
  );
}

function CapHead() {
  return (
    <>
      <th className={numTh}>Monthly cap</th>
      <th className={numTh}>Used</th>
    </>
  );
}

/** Spend per UTC day as plain CSS bars, with a screen-reader table of the same numbers. */
function DailyChart({ daily }: { daily: UsageResponse["daily"] }) {
  if (daily.length === 0) return <Muted>Nothing to chart for this month yet.</Muted>;
  const { max, bars } = dailyBars(daily);
  const labelDay = (day: number) => day === 1 || day % 5 === 0 || day === bars.length;
  return (
    <figure>
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="flex h-44 w-14 flex-col justify-between text-right text-xs text-slate-500 tabular-nums dark:text-slate-400"
        >
          <span className="-translate-y-1/2">{formatUsdShort(max)}</span>
          <span>{formatUsdShort(max / 2)}</span>
          <span className="translate-y-1/2">$0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-44 border-b border-l border-slate-300 dark:border-slate-600">
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 border-t border-dashed border-slate-200 dark:border-slate-700"
            />
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-1/2 border-t border-dashed border-slate-200 dark:border-slate-700"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 flex items-end gap-px px-px sm:gap-0.5"
            >
              {bars.map((b) => (
                <div
                  key={b.date}
                  title={`${b.date}: ${formatCost(b.costMicroUsd)} · ${formatTokens(b.calls)} calls`}
                  className="group flex h-full flex-1 items-end"
                >
                  <div
                    className={cx(
                      "w-full rounded-t-sm bg-teal-600 group-hover:bg-teal-500 dark:bg-teal-500 dark:group-hover:bg-teal-400",
                      b.costMicroUsd > 0 && "min-h-px",
                    )}
                    style={{ height: `${b.height * 100}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div
            aria-hidden="true"
            className="mt-1 flex gap-px px-px text-xs text-slate-500 tabular-nums sm:gap-0.5 dark:text-slate-400"
          >
            {bars.map((b) => (
              <span key={b.date} className="flex-1 text-center">
                {labelDay(b.day) ? b.day : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Cost per day (UTC). Hover a bar for the exact amount.
      </figcaption>
      <table className="sr-only">
        <caption>Cost per day</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Cost</th>
            <th>Calls</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{formatCost(d.costMicroUsd)}</td>
              <td>{d.calls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {empty ? <Muted>No usage this month.</Muted> : children}
    </section>
  );
}

const usd = (dollars: number | null) => (dollars === null ? "No cap" : `$${dollars.toFixed(2)}`);

export function UsagePage() {
  const user = useUser();
  const admin = isAdmin(user);
  const [month, setMonth] = useState(currentMonth());
  const [scope, setScope] = useState<"me" | "all">("me");
  const usage = useResource(
    () => (/^\d{4}-\d{2}$/.test(month) ? api.usage(month, scope) : Promise.resolve(null)),
    [month, scope],
  );
  const data = usage.data;

  return (
    <Page wide>
      <PageHeader
        title="Usage and cost"
        description="Spend, tokens and monthly ceilings per calendar month (UTC)."
        actions={
          /^\d{4}-\d{2}$/.test(month) && (
            <a
              href={usageExportUrl(month, scope)}
              download
              className={cx(
                "inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
                focusRing,
              )}
            >
              Export CSV
            </a>
          )
        }
      />
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <TextField
          label="Month"
          type="month"
          value={month}
          max={currentMonth()}
          onChange={(e) => setMonth(e.target.value || currentMonth())}
        />
        {admin && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Scope</legend>
            <div className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-600">
              {(["me", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => setScope(s)}
                  className={cx(
                    "rounded px-3 py-1.5 text-sm font-medium",
                    focusRing,
                    scope === s
                      ? "bg-teal-700 text-white dark:bg-teal-600"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                  )}
                >
                  {s === "me" ? "Just me" : "Everyone"}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <ErrorText>{usage.error}</ErrorText>
      {usage.loading && !data && <Muted>Loading…</Muted>}
      {data && (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cost" value={formatCost(data.totals.costMicroUsd)} />
            <Stat label="Calls" value={formatTokens(data.totals.calls)} />
            <Stat label="Input tokens" value={formatTokens(data.totals.inputTokens)} />
            <Stat label="Output tokens" value={formatTokens(data.totals.outputTokens)} />
          </div>

          <Card>
            <h2 className="mb-3 font-semibold">Daily spend</h2>
            <DailyChart daily={data.daily} />
          </Card>

          <Section title="By person" empty={data.byUser.length === 0}>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Person</th>
                  <TotalsHead />
                  <CapHead />
                </tr>
              </thead>
              <tbody>
                {data.byUser.map((u) => (
                  <tr key={u.userId ?? "deleted"}>
                    <td className={td}>{u.displayName}</td>
                    <TotalsCells t={u} />
                    <CapCells
                      spent={u.costMicroUsd}
                      capMicro={centsToMicro(u.capCents)}
                      capLabel={formatCents(u.capCents)}
                    />
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>

          <Section title="By crew member" empty={data.byCrew.length === 0}>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Crew member</th>
                  <TotalsHead />
                  <CapHead />
                </tr>
              </thead>
              <tbody>
                {data.byCrew.map((c) => (
                  <tr key={c.slug ?? "none"}>
                    <td className={td}>{c.name}</td>
                    <TotalsCells t={c} />
                    <CapCells
                      spent={c.costMicroUsd}
                      capMicro={usdToMicro(c.capUsd)}
                      capLabel={usd(c.capUsd)}
                    />
                  </tr>
                ))}
              </tbody>
            </Table>
            {scope === "me" && data.byCrew.some((c) => c.capUsd !== null) && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Crew ceilings count everyone's spend; "Used" here shows only yours.
              </p>
            )}
          </Section>

          <Section title="By watch" empty={data.byWatch.length === 0}>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Watch</th>
                  <TotalsHead />
                  <CapHead />
                </tr>
              </thead>
              <tbody>
                {data.byWatch.map((w) => (
                  <tr key={w.watchId}>
                    <td className={td}>
                      <a
                        href={href(`/watches/${w.watchId}`)}
                        className={cx(
                          "rounded text-teal-800 hover:underline dark:text-teal-300",
                          focusRing,
                        )}
                      >
                        {w.name}
                      </a>
                    </td>
                    <TotalsCells t={w} />
                    <CapCells
                      spent={w.costMicroUsd}
                      capMicro={centsToMicro(w.capCents)}
                      capLabel={formatCents(w.capCents)}
                    />
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>

          <Section title="By model" empty={data.byModel.length === 0}>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Model</th>
                  <TotalsHead />
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model}>
                    <td className={`${td} font-mono text-xs`}>{m.model}</td>
                    <TotalsCells t={m} />
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>
        </div>
      )}
    </Page>
  );
}
