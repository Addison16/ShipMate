import type { ReactNode } from "react";
import { Logo } from "./Logo.js";

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-gradient-to-b from-accent-50 to-slate-50 px-4 py-10 dark:from-accent-950/40 dark:to-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5 text-slate-900 dark:text-white">
          <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm">
            <Logo size={22} />
          </span>
          <span className="text-xl font-semibold tracking-tight">Shipmate</span>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-accent-900/5 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
