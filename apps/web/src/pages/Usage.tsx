import type { UsageTotals } from "@shipmate/core";
import { useState } from "react";
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
import { useResource } from "../lib/useResource.js";

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
      <PageHeader title="Usage" description="Tokens and cost per calendar month (UTC)." />
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

          <section>
            <h2 className="mb-2 font-semibold">By user</h2>
            {data.byUser.length === 0 ? (
              <Muted>No usage this month.</Muted>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>User</th>
                    <TotalsHead />
                    <th className={numTh}>Monthly cap</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUser.map((u) => {
                    const over = u.capCents !== null && u.costMicroUsd >= u.capCents * 10_000;
                    return (
                      <tr key={u.userId ?? "routines"}>
                        <td className={td}>{u.displayName}</td>
                        <TotalsCells t={u} />
                        <td className={num}>
                          {formatCents(u.capCents)}
                          {over && (
                            <span className="ml-2">
                              <Badge tone="danger">cap reached</Badge>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </section>

          <section>
            <h2 className="mb-2 font-semibold">By crew member</h2>
            {data.byCrew.length === 0 ? (
              <Muted>No usage this month.</Muted>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Crew member</th>
                    <TotalsHead />
                  </tr>
                </thead>
                <tbody>
                  {data.byCrew.map((c) => (
                    <tr key={c.slug ?? "none"}>
                      <td className={td}>{c.name}</td>
                      <TotalsCells t={c} />
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section>
            <h2 className="mb-2 font-semibold">By model</h2>
            {data.byModel.length === 0 ? (
              <Muted>No usage this month.</Muted>
            ) : (
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
            )}
          </section>
        </div>
      )}
    </Page>
  );
}
