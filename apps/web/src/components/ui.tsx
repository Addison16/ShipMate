import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import { type IconName, NavIcon } from "./icons.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-700 text-white shadow-sm shadow-accent-900/20 hover:bg-accent-800 hover:shadow-md hover:shadow-accent-900/20 disabled:bg-accent-700/50 dark:bg-accent-600 dark:hover:bg-accent-500",
  secondary:
    "border border-slate-300 bg-white text-slate-800 shadow-xs hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
  danger:
    "border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-800 dark:text-red-300 dark:hover:bg-red-950",
  ghost: "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
};

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 dark:focus-visible:outline-accent-400";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        variants[variant],
        focusRing,
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A small always-visible icon action (rename, delete…) for list rows. The label is the tooltip
 * and the accessible name, so the icon never has to carry the meaning alone.
 */
export function IconButton({
  icon,
  label,
  tone = "neutral",
  active,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  tone?: "neutral" | "danger";
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "grid size-9 shrink-0 place-items-center rounded-md transition-colors sm:size-7 disabled:cursor-not-allowed disabled:opacity-50",
        active ? "text-accent-700 dark:text-accent-300" : "text-slate-500 dark:text-slate-400",
        tone === "danger"
          ? "hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/60 dark:hover:text-red-300"
          : "hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-slate-100",
        focusRing,
        className,
      )}
      {...rest}
    >
      <NavIcon name={icon} size={16} />
    </button>
  );
}

const fieldBase =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-slate-400 hover:border-slate-400 focus:border-accent-500 focus:ring-3 focus:ring-accent-500/25 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-500 dark:focus:border-accent-400 dark:focus:ring-accent-400/25 dark:disabled:bg-slate-800";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  className?: string;
}

export function TextField({
  label,
  hint,
  className,
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input id={id} className={fieldBase} {...rest} />
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  className,
  children,
  ...rest
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <select id={id} className={fieldBase} {...rest}>
        {children}
      </select>
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  className,
  mono,
  ...rest
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        spellCheck={mono ? false : undefined}
        className={cx(fieldBase, mono && "font-mono text-[13px] leading-relaxed")}
        {...rest}
      />
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cx(
        "rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-700/80 dark:bg-slate-900",
        className,
      )}
    >
      {children}
    </section>
  );
}

type Tone = "neutral" | "accent" | "warn" | "danger" | "ok";
const tones: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  accent: "bg-accent-100 text-accent-800 dark:bg-accent-900/60 dark:text-accent-200",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="animate-fade-in rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm whitespace-pre-wrap text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
    >
      {children}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="animate-fade-in rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-900 dark:border-accent-900 dark:bg-accent-950/50 dark:text-accent-100">
      {children}
    </p>
  );
}

/** Shimmering placeholder lines while something loads; screen readers hear "Loading…". */
export function Loading({ lines = 3, label = "Loading…" }: { lines?: number; label?: string }) {
  return (
    <div role="status" className="animate-fade-in space-y-2.5 py-1">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          key={i}
          aria-hidden="true"
          className="skeleton h-3.5 rounded-full"
          style={{ width: `${[92, 76, 84, 64, 88][i % 5]}%` }}
        />
      ))}
    </div>
  );
}

/** Placeholder cards for a grid that is loading. */
export function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div role="status" className="grid animate-fade-in gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cards
          key={i}
          aria-hidden="true"
          className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-start gap-3">
            <div className="skeleton size-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2.5 pt-1">
              <div className="skeleton h-3.5 w-1/3 rounded-full" />
              <div className="skeleton h-3 w-11/12 rounded-full" />
              <div className="skeleton h-3 w-2/3 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A friendly "nothing here yet" panel with an icon, a line of help and an optional action. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex animate-fade-up flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/40",
        className,
      )}
    >
      <span className="relative mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-accent-100 to-accent-200 text-accent-700 shadow-sm ring-1 ring-accent-600/10 dark:from-accent-900/70 dark:to-accent-950 dark:text-accent-300 dark:ring-accent-400/15">
        {icon}
      </span>
      <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {children && (
        <div className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{children}</div>
      )}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** A sidebar icon shown in a tile beside the title, so each place is recognisable at a glance. */
  icon?: IconName;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3.5">
        {icon && (
          <span
            aria-hidden="true"
            className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-md shadow-accent-900/20 ring-1 ring-white/20 ring-inset"
          >
            <NavIcon name={icon} size={20} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("mx-auto w-full px-4 py-6 sm:px-6", wide ? "max-w-6xl" : "max-w-4xl")}>
      {children}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    // `relative` keeps absolutely positioned cell content (sr-only labels) inside the scroller,
    // so a wide table scrolls in its card instead of widening the page on phones.
    <div className="relative overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-left text-sm [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-slate-50/70 dark:[&_tbody_tr:hover]:bg-slate-800/40">
        {children}
      </table>
    </div>
  );
}

export const th =
  "bg-slate-50 px-3 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-800/60 dark:text-slate-300";
export const td = "border-t border-slate-200 px-3 py-2 dark:border-slate-700";
