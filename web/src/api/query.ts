/**
 * Small stale-while-revalidate cache for GET requests (keyed by API path):
 * a screen you've seen opens instantly from memory and refreshes quietly;
 * identical requests in flight are shared; hovering a link can prefetch.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./client";

interface Entry {
  data?: unknown;
  error?: unknown;
  promise?: Promise<unknown>;
  at: number;
  subs: Set<() => void>;
}

const cache = new Map<string, Entry>();
const FRESH_MS = 15_000;

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { at: 0, subs: new Set() };
    cache.set(key, e);
  }
  return e;
}

function notify(e: Entry) {
  for (const fn of e.subs) fn();
}

/** Load (or join the request already loading) and store the result. */
export function fetchQuery<T>(key: string): Promise<T> {
  const e = entry(key);
  if (e.promise) return e.promise as Promise<T>;
  const p = api<T>(key)
    .then((data) => {
      e.data = data;
      e.error = undefined;
      e.at = Date.now();
      return data;
    })
    .catch((err) => {
      e.error = err;
      throw err;
    })
    .finally(() => {
      e.promise = undefined;
      notify(e);
    });
  e.promise = p;
  notify(e);
  return p;
}

/** Warm the cache before the user gets there (link hover / focus). */
export function prefetch(key: string) {
  const e = cache.get(key);
  if (e && (e.promise || Date.now() - e.at < FRESH_MS)) return;
  void fetchQuery(key).catch(() => {});
}

/** Put a known result in the cache (after a mutation that returns it). */
export function setQueryData<T>(key: string, updater: T | ((old: T | undefined) => T)) {
  const e = entry(key);
  e.data = typeof updater === "function" ? (updater as (o: T | undefined) => T)(e.data as T | undefined) : updater;
  e.at = Date.now();
  notify(e);
}

/** Mark matching entries stale and reload the ones on screen. */
export function invalidate(prefix: string) {
  for (const [key, e] of cache) {
    if (!key.startsWith(prefix)) continue;
    e.at = 0;
    if (e.subs.size) void fetchQuery(key).catch(() => {});
  }
}

export function clearQueryCache() {
  cache.clear();
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** Nothing to show yet (first load): render a skeleton. */
  isLoading: boolean;
  /** A request is running (first load or a quiet refresh). */
  isFetching: boolean;
  refetch: () => Promise<T>;
}

export function useQuery<T>(key: string | null): QueryResult<T> {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!key) return () => {};
      const e = entry(key);
      e.subs.add(fn);
      return () => e.subs.delete(fn);
    },
    [key],
  );
  const snapshot = useCallback(() => (key ? cache.get(key) : undefined), [key]);
  useSyncExternalStore(subscribe, () => {
    const e = snapshot();
    // A changing primitive so React re-renders when this entry changes.
    return e ? `${e.at}|${e.promise ? 1 : 0}|${e.error ? 1 : 0}` : "";
  });

  useEffect(() => {
    if (!key) return;
    const e = entry(key);
    if (!e.promise && Date.now() - e.at >= FRESH_MS) void fetchQuery(key).catch(() => {});
  }, [key]);

  const e = snapshot();
  const refetch = useCallback(() => fetchQuery<T>(key!), [key]);
  return {
    data: e?.data as T | undefined,
    error: e?.data === undefined ? e?.error : undefined,
    isLoading: !!key && e?.data === undefined && !e?.error,
    isFetching: !!e?.promise,
    refetch,
  };
}
