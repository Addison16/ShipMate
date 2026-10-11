import { useEffect, useState } from "react";

type Meta = { version: string; coreMcpServers: string[] };

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/meta")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <main className="mx-auto max-w-2xl p-6 font-sans">
      <h1 className="text-3xl font-semibold">Shipmate</h1>
      <p className="mt-2 text-neutral-600">
        Your crew is not aboard yet. The Bridge, Crew, Watches and Shipyard pages arrive in phase 1.
      </p>
      <section className="mt-6 rounded-lg border p-4 text-sm">
        {error && <p className="text-red-600">Server unreachable: {error}</p>}
        {meta && (
          <>
            <p>
              Server version <code>{meta.version}</code>
            </p>
            <p className="mt-1">Core MCP servers: {meta.coreMcpServers.join(", ")}</p>
          </>
        )}
        {!meta && !error && <p>Connecting…</p>}
      </section>
    </main>
  );
}
