import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.js";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (data: T) => void;
}

/** Fetch on mount and whenever `deps` change; `reload` refetches without clearing data. */
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (mine === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Refetch when the caller's inputs change; serialised so a fresh array literal is stable.
  const depsKey = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: depsKey stands in for the caller's deps
  useEffect(() => {
    void reload();
  }, [depsKey, reload]);

  return { data, error, loading, reload, setData };
}
