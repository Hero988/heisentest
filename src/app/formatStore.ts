/**
 * Saved custom formats, persisted in localStorage and auto-applied when a
 * file with a recognized shape signature is dropped again.
 */

import type { FormatSpec } from "../engine/custom";
import type { KnownFormat } from "../engine/protocol";

const KEY = "heisentest.formats.v1";

function load(): Record<string, FormatSpec> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, FormatSpec>;
    }
  } catch {
    /* corrupted or unavailable storage — start fresh */
  }
  return {};
}

export function knownFormats(): KnownFormat[] {
  return Object.entries(load()).map(([signature, spec]) => ({ signature, spec }));
}

export function savedFormat(signature: string | null): FormatSpec | null {
  if (signature === null) return null;
  return load()[signature] ?? null;
}

export function saveFormat(signature: string, spec: FormatSpec): void {
  const all = load();
  all[signature] = spec;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full/unavailable — the session still works */
  }
}

export function removeFormat(signature: string): void {
  const all = load();
  delete all[signature];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
