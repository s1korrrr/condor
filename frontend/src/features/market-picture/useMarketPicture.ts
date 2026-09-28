import { useCallback, useEffect, useRef, useState } from "react";
import { acceptFrame, pollDelay } from "./model.mjs";
import { fetchBundle, type FrameBundle } from "./source";

/** One scheduler owns the page. Dependent reads are pinned to the selected frame. */
export function useMarketPicture(
  server: string | null,
  window: string,
  benchmark: string,
  fixture?: FrameBundle,
) {
  const [bundle, setBundle] = useState<FrameBundle | null>(fixture ?? null);
  const [frozen, setFrozen] = useState<FrameBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!fixture);
  const [refresh, setRefresh] = useState(0);
  const current = useRef<FrameBundle | null>(fixture ?? null);
  const replayAbort = useRef<AbortController | null>(null);
  const retry = useCallback(() => setRefresh((n) => n + 1), []);
  const options = useRef("");
  const frozenId = frozen?.frame.snapshot_id;

  useEffect(() => {
    if (fixture || !server) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0,
      stopped = false,
      inflight = false;
    const optionKey = `${window}:${benchmark}`;
    const poll = async () => {
      if (stopped || inflight || document.hidden) return;
      clearTimeout(timer);
      controller = new AbortController();
      const request = controller;
      inflight = true;
      try {
        const candidate = await fetchBundle(
          server,
          window,
          benchmark,
          request.signal,
          options.current === optionKey ? current.current : null,
          frozenId,
        );
        if (stopped || request.signal.aborted) return;
        if (frozenId) setFrozen(candidate);
        else {
          acceptFrame(current.current?.frame ?? null, candidate.frame);
          current.current = candidate;
          setBundle(candidate);
        }
        options.current = optionKey;
        setError(null);
        setLoading(false);
        failures = 0;
      } catch (failure) {
        if (stopped || request.signal.aborted) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Market Picture source is unavailable.",
        );
        setLoading(false);
        failures += 1;
      } finally {
        inflight = false;
        if (!stopped && !document.hidden && !frozenId)
          timer = setTimeout(poll, pollDelay(failures));
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else if (!inflight) void poll();
    };
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [server, window, benchmark, fixture, refresh, frozenId]);

  // Replay belongs to the source and view that requested it. A late reply must
  // not freeze a new benchmark/window using components from the previous view.
  useEffect(
    () => () => replayAbort.current?.abort(),
    [server, window, benchmark, fixture],
  );
  const replay = useCallback(
    async (snapshotId: string) => {
      if (!server || fixture) return;
      replayAbort.current?.abort();
      const controller = new AbortController();
      replayAbort.current = controller;
      try {
        const selected = await fetchBundle(
          server,
          window,
          benchmark,
          controller.signal,
          null,
          snapshotId,
        );
        if (!controller.signal.aborted) {
          setFrozen(selected);
          setError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Recorded frame unavailable.",
          );
      }
    },
    [server, window, benchmark, fixture],
  );
  const toggleFreeze = () => {
    replayAbort.current?.abort();
    if (frozen) {
      setFrozen(null);
      retry();
    } else if (bundle) setFrozen(bundle);
  };
  return {
    data: frozen ?? bundle,
    frozen: Boolean(frozen),
    error,
    loading: loading && !bundle,
    retry,
    replay,
    toggleFreeze,
  };
}
