import type { TaskDto } from "@shipmate/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { api } from "./api.js";
import { initialTasks, type TasksState, tasksReducer } from "./lib/tasks.js";
import { useServerEvents, useSocketState } from "./ws.js";

interface TasksContextValue extends TasksState {
  /** Load one chat's tasks: those handed over in it, or the task that lives in it. */
  loadChat: (conversationId: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
}

const TasksContext = createContext<TasksContextValue | null>(null);

/** Holds the signed-in person's background tasks; mount once inside the shell. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tasksReducer, initialTasks);
  const socketState = useSocketState();

  useServerEvents((event) => {
    if (
      event.type === "task" ||
      event.type === "tool" ||
      event.type === "delta" ||
      event.type === "stream_start"
    ) {
      dispatch({ type: "event", event });
    }
  });

  const load = useCallback(async (conversationId?: string) => {
    try {
      const { tasks } = await api.listTasks(conversationId);
      dispatch({ type: "loaded", tasks });
    } catch {
      // Cards then show without a live state; the next event or reload fills it in.
    }
  }, []);

  // On app load, and whenever the socket (re)opens, since events may have been missed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (socketState === "open" && !wasOpen.current) void load();
    wasOpen.current = socketState === "open";
  }, [socketState, load]);
  useEffect(() => {
    void load();
  }, [load]);

  const stop = useCallback(async (id: string) => {
    const { task } = await api.stopTask(id);
    dispatch({ type: "event", event: { type: "task", task } });
  }, []);

  return (
    <TasksContext.Provider value={{ ...state, loadChat: load, stop }}>
      {children}
    </TasksContext.Provider>
  );
}

const noTasks: TasksContextValue = {
  byId: {},
  activity: {},
  loadChat: async () => {},
  stop: async () => {},
};

/** Outside the shell (a test, a preview) there are simply no tasks. */
export function useTasks(): TasksContextValue {
  return useContext(TasksContext) ?? noTasks;
}

export function useTask(id: string): TaskDto | null {
  return useTasks().byId[id] ?? null;
}
