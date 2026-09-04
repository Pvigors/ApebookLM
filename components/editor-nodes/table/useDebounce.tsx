"use client";

// Small debounce hook used by TableHoverActionsPlugin (mirrors the Lexical
// playground's useDebounce util).

import { useEffect, useMemo, useRef } from "react";

type DebouncedFn<A extends unknown[]> = ((...args: A) => void) & { cancel: () => void };

export function useDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  maxWait?: number
): DebouncedFn<A> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstCallRef = useRef<number | null>(null);

  const debounced = useMemo(() => {
    const run = (...args: A) => {
      const now = Date.now();
      if (firstCallRef.current == null) firstCallRef.current = now;
      const elapsed = now - firstCallRef.current;
      const fire = () => {
        firstCallRef.current = null;
        timeoutRef.current = null;
        fnRef.current(...args);
      };
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
      if (maxWait != null && elapsed >= maxWait) {
        fire();
        return;
      }
      timeoutRef.current = setTimeout(fire, ms);
    };
    (run as DebouncedFn<A>).cancel = () => {
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      firstCallRef.current = null;
    };
    return run as DebouncedFn<A>;
  }, [ms, maxWait]);

  useEffect(() => () => debounced.cancel(), [debounced]);
  return debounced;
}
