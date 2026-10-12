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
  type ChartMetric,
  capTone,
  centsToMicro,
  dailyBars,
  defaultMetric,
  formatAxis,
  formatDuration,
  formatEstimate,
  formatPercent,
  percentUsed,
  usageExportUrl,
  usdToMicro,
} from "../lib/usage.js";
import { useResource } from "../lib/useResource.js";
import { href } from "../router.js";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </Card>
  );
}

const num = `${td} text-right tabular-nums`;
const numTh = `${th} text-right`;

/** `subs`: the month has subscription calls, so show their API-price estimate column. */
function TotalsCells({ t, subs }: { t: UsageTotals; subs: boolean }) {
  return (
    <>
      <td className={num}>{formatTokens(t.calls)}</td>
      <td className={num}>{formatTokens(t.inputTokens)}</td>
      <td className={num}>{formatTokens(t.outputTokens)}</td>
      <td className={num}>{formatTokens(t.cacheReadTokens + t.cacheWriteTokens)}</td>
      <td className={num}>{formatCost(t.costMicroUsd)}</td>
      {subs && (
        <td className={num}>
          {t.subscriptionCalls > 0 ? (
            formatEstimate(t.apiEquivalentMicroUsd)
          ) : (
            <span className="text-slate-400 dark:text-slate-500">—</span>
          )}
        </td>
      )}
      <td className={num}>{formatDuration(t.avgResponseMs)}</td>
      <td className={num}>{formatDuration(t.p95ResponseMs)}</td>
    </>
  );
}

function TotalsHead({ subs }: { subs: boolean }) {
  return (
    <>
      <th className={numTh}>Calls</th>
      <th className={numTh}>Input</th>
      <th className={numTh}>Output</th>
      <th className={numTh}>Cache</th>
      <th className={numTh}>
        <abbr title="Real spend on API keys" className="no-underline">
          API cost
        </abbr>
      </th>
      {subs && (
        <th className={numTh}>
          <abbr
            title="What the calls covered by a subscription would have cost at API prices (estimate)"
            className="no-underline"
          >
            Subscription value
          </abbr>
        </th>
      )}
      <th className={numTh}>
        <abbr title="Average time the model took to answer" className="no-underline">
          Avg time
        </abbr>
      </th>
      <th className={numTh}>
        <abbr title="95% of answers came at least this fast" className="no-underline">
          p95
        </abbr>
      </th>
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

const METRICS: Array<{ id: ChartMetric; label: string; caption: string }> = [
  { id: "cost", label: "API cost", caption: "API spend per day (UTC)." },
  {
    id: "saved",
    label: "Subscription value",
    caption:
      "What subscription calls would have cost at API prices, per day (UTC). An estimate, not spend.",
  },
  { id: "tokens", label: "Tokens", caption: "Input and output tokens per day (UTC)." },
  {
    id: "time",
    label: "Response time",
    caption: "Average time the model took to answer, per day (UTC).",
  },
];

/** One day's numbers in every metric, for the hover title and the screen-reader table. */
const dayCells = (d: UsageResponse["daily"][number]) => ({
  cost: formatCost(d.costMicroUsd),
  saved: formatEstimate(d.apiEquivalentMicroUsd),
  tokens: formatTokens(d.tokens),
  time: formatDuration(d.avgResponseMs),
  calls: formatTokens(d.calls),
});

/** One metric per UTC day as plain CSS bars, with a screen-reader table of the same numbers. */
function DailyChart({ daily, metric }: { daily: UsageResponse["daily"]; metric: ChartMetric }) {
  if (daily.length === 0) return <Muted>Nothing to chart for this month yet.</Muted>;
  const { max, bars } = dailyBars(daily, metric);
  const labelDay = (day: number) => day === 1 || day % 5 === 0 || day === bars.length;
  const caption = METRICS.find((m) => m.id === metric)?.caption ?? "";
  return (
    <figure>
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="flex h-44 w-14 flex-col justify-between text-right text-xs text-slate-500 tabular-nums dark:text-slate-400"
        >
          <span className="-translate-y-1/2">{formatAxis(max, metric)}</span>
          <span>{formatAxis(max / 2, metric)}</span>
          <span className="translate-y-1/2">{formatAxis(0, metric)}</span>
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
              {bars.map((b) => {
                const c = dayCells(b);
                return (
                  <div
                    key={b.date}
                    title={`${b.date}: ${c.cost}${b.apiEquivalentMicroUsd > 0 ? ` (+ ${c.saved} on subscriptions)` : ""} · ${c.tokens} tokens · ${c.calls} calls · avg ${c.time}`}
                    className="group flex h-full flex-1 items-end"
                  >
                    <div
                      className={cx(
                        "w-full rounded-t-sm bg-accent-600 group-hover:bg-accent-500 dark:bg-accent-500 dark:group-hover:bg-accent-400",
                        b.value > 0 && "min-h-px",
                      )}
                      style={{ height: `${b.height * 100}%` }}
                    />
                  </div>
                );
              })}
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
        {caption} Hover a bar for the exact numbers.
      </figcaption>
      <table className="sr-only">
        <caption>Usage per day</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>API cost</th>
            <th>Subscription value (estimate)</th>
            <th>Tokens</th>
            <th>Calls</th>
            <th>Average response time</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => {
            const c = dayCells(d);
            return (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{c.cost}</td>
                <td>{c.saved}</td>
                <td>{c.tokens}</td>
                <td>{c.calls}</td>
                <td>{c.time}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}

/** A small segmented control (the scope and the chart metric). */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-600">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            "rounded px-3 py-1.5 text-sm font-medium",
            focusRing,
            value === o.id
              ? "bg-accent-700 text-white dark:bg-accent-600"
              : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
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
  // null: pick for the data (tokens when everything was free, as with local models).
  const [chosenMetric, setMetric] = useState<ChartMetric | null>(null);
  const usage = useResource(
    () => (/^\d{4}-\d{2}$/.test(month) ? api.usage(month, scope) : Promise.resolve(null)),
    [month, scope],
  );
  const data = usage.data;
  const metric = chosenMetric ?? (data ? defaultMetric(data.totals) : "cost");
  const subs = data !== null && data.totals.subscriptionCalls > 0;
  // Every call ran on a free (local) model: nothing spent and nothing on a subscription.
  const free = data !== null && data.totals.calls > 0 && data.totals.costMicroUsd === 0 && !subs;
  const allOnSubscription = subs && data.totals.subscriptionCalls === data.totals.calls;

  return (
    <Page wide>
      <PageHeader
        title="Usage and cost"
        description="Spend, tokens, response times and monthly ceilings per calendar month (UTC)."
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
          <div>
            <p aria-hidden="true" className="mb-1 text-sm font-medium">
              Scope
            </p>
            <Segmented
              label="Scope"
              value={scope}
              options={[
                { id: "me", label: "Just me" },
                { id: "all", label: "Everyone" },
              ]}
              onChange={setScope}
            />
          </div>
        )}
      </div>

      <ErrorText>{usage.error}</ErrorText>
      {usage.loading && !data && <Muted>Loading…</Muted>}
      {data && (
        <div className="space-y-8">
          <div
            className={cx(
              "grid grid-cols-2 gap-3 sm:grid-cols-3",
              subs ? "lg:grid-cols-6" : "lg:grid-cols-5",
            )}
          >
            <Stat
              label="API spend"
              value={formatCost(data.totals.costMicroUsd)}
              {...(free
                ? { hint: "Free models only" }
                : allOnSubscription
                  ? { hint: "All covered by subscriptions" }
                  : {})}
            />
            {subs && (
              <Stat
                label="Saved by subscriptions"
                value={formatEstimate(data.totals.apiEquivalentMicroUsd)}
                hint={`Estimate at API prices · ${formatTokens(data.totals.subscriptionCalls)} calls`}
              />
            )}
            <Stat label="Calls" value={formatTokens(data.totals.calls)} />
            <Stat label="Input tokens" value={formatTokens(data.totals.inputTokens)} />
            <Stat label="Output tokens" value={formatTokens(data.totals.outputTokens)} />
            <Stat
              label="Avg response"
              value={formatDuration(data.totals.avgResponseMs)}
              {...(data.totals.p95ResponseMs !== null
                ? { hint: `p95 ${formatDuration(data.totals.p95ResponseMs)}` }
                : {})}
            />
          </div>

          {subs && (
            <p className="-mt-5 text-xs text-slate-500 dark:text-slate-400">
              Calls through the Claude Code CLI or a ChatGPT plan are covered by that subscription,
              so they are not counted as spend or towards caps. "Saved by subscriptions" estimates
              what they would have cost on an API key, from the provider's API prices.
            </p>
          )}

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Daily usage</h2>
              <Segmented
                label="Chart"
                value={metric}
                options={METRICS.filter((m) => subs || m.id !== "saved").map((m) => ({
                  id: m.id,
                  label: m.label,
                }))}
                onChange={setMetric}
              />
            </div>
            {free && chosenMetric === null && (
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Everything this month ran on free (local) models, so the chart shows tokens.
              </p>
            )}
            {metric === "saved" && chosenMetric === null && (
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Nothing this month was spent on API keys, so the chart shows what your subscriptions
                covered.
              </p>
            )}
            <DailyChart daily={data.daily} metric={metric} />
          </Card>

          <Section title="By person" empty={data.byUser.length === 0}>
            <Table>
              <thead>
                <tr>
                  <th className={th}>Person</th>
                  <TotalsHead subs={subs} />
                  <CapHead />
                </tr>
              </thead>
              <tbody>
                {data.byUser.map((u) => (
                  <tr key={u.userId ?? "deleted"}>
                    <td className={td}>{u.displayName}</td>
                    <TotalsCells t={u} subs={subs} />
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
                  <TotalsHead subs={subs} />
                  <CapHead />
                </tr>
              </thead>
              <tbody>
                {data.byCrew.map((c) => (
                  <tr key={c.slug ?? "none"}>
                    <td className={td}>{c.name}</td>
                    <TotalsCells t={c} subs={subs} />
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
                  <TotalsHead subs={subs} />
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
                          "rounded text-accent-800 hover:underline dark:text-accent-300",
                          focusRing,
                        )}
                      >
                        {w.name}
                      </a>
                    </td>
                    <TotalsCells t={w} subs={subs} />
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
                  <TotalsHead subs={subs} />
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model}>
                    <td className={`${td} font-mono text-xs`}>{m.model}</td>
                    <TotalsCells t={m} subs={subs} />
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
