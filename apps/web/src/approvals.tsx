import type { ApprovalDecision } from "@shipmate/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "./api.js";
import { type ApprovalsState, approvalsReducer, initialApprovals } from "./lib/approvals.js";
import { socket, useServerEvents, useSocketState } from "./ws.js";

interface ApprovalsContextValue extends ApprovalsState {
  answer: (id: string, decision: ApprovalDecision) => Promise<void>;
  /** Last error from answering or restoring, keyed by approval id ("" for restore). */
  errors: Record<string, string>;
}

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

/** Holds every pending approval for the signed-in person; mount once inside the shell. */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(approvalsReducer, initialApprovals);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const socketState = useSocketState();

  useServerEvents((event) => {
    if (event.type === "approval_request" || event.type === "approval_resolved") {
      dispatch({ type: "event", event });
    }
  });

  const restore = useCallback(async () => {
    try {
      const { approvals } = await api.listApprovals();
      dispatch({ type: "restore", approvals });
      setErrors((e) => {
        const { "": _, ...rest } = e;
        return rest;
      });
    } catch (err) {
      setErrors((e) => ({ ...e, "": errorMessage(err) }));
    }
  }, []);

  // On app load, and every time the socket (re)opens, since events may have been missed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (socketState === "open" && !wasOpen.current) void restore();
    wasOpen.current = socketState === "open";
  }, [socketState, restore]);
  useEffect(() => {
    void restore();
  }, [restore]);

  const answer = useCallback(async (id: string, decision: ApprovalDecision) => {
    dispatch({ type: "answering", id });
    setErrors(({ [id]: _, ...rest }) => rest);
    if (socket.send({ type: "approve", approvalId: id, decision })) {
      // If the server never confirms (e.g. the socket dropped mid-send), let the person retry.
      setTimeout(() => dispatch({ type: "answerFailed", id }), 10_000);
      return;
    }
    try {
      await api.decideApproval(id, decision);
      dispatch({ type: "resolved", id, decision });
    } catch (err) {
      dispatch({ type: "answerFailed", id });
      setErrors((e) => ({ ...e, [id]: errorMessage(err) }));
    }
  }, []);

  return (
    <ApprovalsContext.Provider value={{ ...state, errors, answer }}>
      {children}
    </ApprovalsContext.Provider>
  );
}

export function useApprovals(): ApprovalsContextValue {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) throw new Error("useApprovals outside ApprovalsProvider");
  return ctx;
}
