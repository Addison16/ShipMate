import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The empty middle of the phone top bar, where a page can put its own title. */
export const TopBarSlot = createContext<HTMLElement | null>(null);

/**
 * Shows `children` in the middle of the phone top bar. Renders nothing on wide screens (the bar
 * is hidden there) or outside the Shell, so pages keep their own title for those.
 */
export function TopBarTitle({ children }: { children: ReactNode }) {
  const slot = useContext(TopBarSlot);
  if (!slot) return null;
  return createPortal(<div data-topbar-title="">{children}</div>, slot);
}
