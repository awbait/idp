import { useCallback, useEffect, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

// useAsync runs an async fn on mount and whenever deps change. The fn receives an
// AbortSignal that is aborted on unmount or before the next run; forward it to
// fetch (see api client) to actually cancel in-flight requests when deps change
// quickly. A `() => Promise<T>` fn that ignores the signal is still accepted.
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);
    run(controller.signal)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        // Ignore errors from a request we deliberately cancelled.
        if (!alive || controller.signal.aborted || (e as Error)?.name === "AbortError") return;
        setError(e as Error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
