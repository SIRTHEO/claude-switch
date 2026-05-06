// src/ui/hooks/use-async-action.ts
// Wraps a sync-or-async action with busy + result-message bookkeeping. The
// returned `run` is what input handlers call; the returned state drives the
// renderer (busy spinner + StatusMessage banner).

import { useCallback, useState } from 'react';

export type MessageKind = 'info' | 'success' | 'error' | 'warning';

export interface ActionMessage {
  kind: MessageKind;
  text: string;
}

export interface UseAsyncAction {
  busy: boolean;
  message: ActionMessage | null;
  run: (fn: () => string | Promise<string>) => Promise<void>;
  setMessage: (m: ActionMessage | null) => void;
}

export function useAsyncAction(): UseAsyncAction {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  const run = useCallback(async (fn: () => string | Promise<string>) => {
    setBusy(true);
    try {
      const text = await fn();
      setMessage({ kind: 'success', text });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, message, run, setMessage };
}
