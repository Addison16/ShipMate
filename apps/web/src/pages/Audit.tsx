import type { AuditEventDto } from "@shipmate/core";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import {
  Badge,
  Button,
  ErrorText,
  Muted,
  Page,
  PageHeader,
  SelectField,
  Table,
  td,
  th,
} from "../components/ui.js";
import { useResource } from "../lib/useResource.js";

const PAGE = 50;

function decisionTone(d: string): "ok" | "danger" | "warn" | "accent" | "neutral" {
  switch (d) {
    case "approved":
    case "always":
      return "ok";
    case "denied":
    case "blocked":
      return "danger";
    case "auto":
      return "neutral";
    default:
      return "warn";
  }
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AuditPage() {
  const user = useUser();
  const admin = isAdmin(user);
  const crew = useResource(() => api.listCrew(true).then((r) => r.crew));
  const users = useResource(
    () => (admin ? api.listUsers().then((r) => r.users) : Promise.resolve([])),
    [admin],
  );
  const [crewFilter, setCrewFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);

  async function load(before?: string) {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const { events: page } = await api.audit({
        crew: crewFilter || undefined,
        user: admin ? userFilter || undefined : undefined,
        before,
        limit: PAGE,
      });
      if (mine !== seq.current) return;
      setEvents((prev) => (before ? [...prev, ...page] : page));
      setMore(page.length >= PAGE);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload from the top when filters change
  useEffect(() => {
    setEvents([]);
    void load();
  }, [crewFilter, userFilter]);

  const last = events[events.length - 1];

  return (
    <Page wide>
      <PageHeader
        title="Audit"
        description={
          admin
            ? "Every tool call and approval, newest first."
            : "Your tool calls and approvals, newest first."
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Crew member"
          value={crewFilter}
          onChange={(e) => setCrewFilter(e.target.value)}
        >
          <option value="">All crew</option>
          {crew.data?.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </SelectField>
        {admin && (
          <SelectField
            label="Person"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
          >
            <option value="">Everyone</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </SelectField>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {!loading && events.length === 0 && !error && <Muted>Nothing logged yet.</Muted>}
      {events.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th className={th}>Time</th>
              <th className={th}>Person</th>
              <th className={th}>Crew</th>
              <th className={th}>Action</th>
              <th className={th}>Summary</th>
              <th className={th}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="align-top">
                <td className={`${td} whitespace-nowrap text-slate-600 dark:text-slate-300`}>
                  <time dateTime={e.createdAt}>{formatStamp(e.createdAt)}</time>
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  {e.user ? (e.user.id === user.id ? "You" : e.user.name) : "—"}
                </td>
                <td className={`${td} whitespace-nowrap`}>{e.crew?.name ?? "—"}</td>
                <td className={`${td} font-mono text-xs whitespace-nowrap`}>{e.action}</td>
                <td className={`${td} min-w-[16rem] break-words`}>{e.summary}</td>
                <td className={td}>
                  {e.decision ? (
                    <Badge tone={decisionTone(e.decision)}>{e.decision}</Badge>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {loading && <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Loading…</p>}
      {more && !loading && last && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => void load(last.createdAt)}>Load more</Button>
        </div>
      )}
    </Page>
  );
}
