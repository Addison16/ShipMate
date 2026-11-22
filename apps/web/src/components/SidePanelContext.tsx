import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { PanelItem } from "../lib/side-panel.js";

interface PanelControl {
  item: PanelItem | null;
  open: (item: PanelItem) => void;
  close: () => void;
}

const PanelContext = createContext<PanelControl | null>(null);

/** The side panel of the chat this is rendered in; null where there is none (settings pages). */
export const useSidePanel = () => useContext(PanelContext);

/**
 * Holds what is open beside the chat. `scope` is the chat's id: switching chats closes the
 * panel, so one chat's page is never left showing next to another.
 */
export function SidePanelProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [state, setState] = useState<{ scope: string; item: PanelItem } | null>(null);
  // Another chat: forget what was open, so coming back does not reopen it.
  if (state && state.scope !== scope) setState(null);
  const item = state && state.scope === scope ? state.item : null;
  const control = useMemo<PanelControl>(
    () => ({
      item,
      open: (next) => setState({ scope, item: next }),
      close: () => setState(null),
    }),
    [item, scope],
  );
  return <PanelContext.Provider value={control}>{children}</PanelContext.Provider>;
}
