import { useCallback, useEffect, useState } from "react";
import * as api from "./api.js";

/** The server state, kept current by the `server-state` event. */
export function useServerState() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let alive = true;
    api.serverState().then((next) => { if (alive) setState(next); }, () => {});
    const stop = api.onServerState((next) => { if (alive) setState(next); });
    return () => { alive = false; stop(); };
  }, []);
  return state;
}

/** The updater status, kept current by the `update-state` event. */
export function useUpdateStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    api.updateState().then((next) => { if (alive) setStatus(next); }, () => {});
    const stop = api.onUpdateState((next) => { if (alive) setStatus(next); });
    return () => { alive = false; stop(); };
  }, []);
  return [status, setStatus];
}

/**
 * One pending action at a time per section: `run(label, fn)` records the
 * label while `fn` runs and keeps its error message. Resolves to fn's result,
 * or undefined when it failed.
 */
export function useAction() {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const run = useCallback(async (label, fn) => {
    setPending(label);
    setError("");
    try {
      return await fn();
    } catch (failure) {
      setError(api.errorText(failure));
      return undefined;
    } finally {
      setPending(null);
    }
  }, []);
  return { pending, error, setError, run };
}
