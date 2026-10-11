import { avatarTone, initials } from "../lib/avatar.js";
import { cx } from "./ui.js";

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold select-none",
        size === "sm" ? "size-6 text-[11px]" : size === "lg" ? "size-12 text-lg" : "size-9 text-sm",
        avatarTone(name),
      )}
    >
      {initials(name)}
    </span>
  );
}
