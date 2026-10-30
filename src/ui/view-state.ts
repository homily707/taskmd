import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** One `localStorage` entry holds every remembered panel field. */
const KEY = 'taskmd.ui.v1';

function storage(): Storage | undefined {
  try { return (globalThis as { localStorage?: Storage }).localStorage; } catch { return; }
}

function read(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(KEY) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * One field of the panel's view state, remembered in `localStorage` so reopening
 * the panel returns to the previous selection, view, width and filters instead
 * of the initial page. Storage failures degrade to plain component state.
 */
export function useStored<T>(field: string, fallback: T, accept: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = read()[field];
    return accept(stored) ? stored : fallback;
  });
  const update = useCallback<Dispatch<SetStateAction<T>>>(next => setValue(previous => {
    const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
    try { storage()?.setItem(KEY, JSON.stringify({ ...read(), [field]: resolved })); } catch { /* quota or disabled storage */ }
    return resolved;
  }), [field]);
  return [value, update];
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
