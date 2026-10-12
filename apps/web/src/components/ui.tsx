import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-700 text-white hover:bg-accent-800 disabled:bg-accent-700/50 dark:bg-accent-600 dark:hover:bg-accent-700",
  secondary:
    "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
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
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        variants[variant],
        focusRing,
        className,
      )}
      {...rest}
    />
  );
}

const fieldBase =
  "w-full rounded-md border border-control bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 disabled:bg-slate-100 disabled:text-slate-500 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-400 dark:disabled:bg-slate-800 " +
  focusRing;

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
        "rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900",
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
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm whitespace-pre-wrap text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
    >
      {children}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-900 dark:border-accent-900 dark:bg-accent-950/50 dark:text-accent-100">
      {children}
    </p>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        )}
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
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export const th =
  "bg-slate-50 px-3 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-800/60 dark:text-slate-300";
export const td = "border-t border-slate-200 px-3 py-2 dark:border-slate-700";
