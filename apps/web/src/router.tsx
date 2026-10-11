import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, "");
  return h.startsWith("/") ? h : `/${h}`;
}

/** Current hash path split into decoded segments, e.g. "#/crew/galley" → ["crew", "galley"]. */
export function useRoute(): string[] {
  const path = useSyncExternalStore(subscribe, currentPath);
  return path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
}

export function navigate(path: string) {
  window.location.hash = path.startsWith("/") ? path : `/${path}`;
}

export function href(path: string): string {
  return `#${path.startsWith("/") ? path : `/${path}`}`;
}
