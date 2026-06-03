import { SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

/**
 * Drops status-history entries whose `iclassOsStatusId` repeats, keeping the
 * first occurrence (order preserved). IClass occasionally returns a transition
 * twice (e.g. OS 4691 returned id 243692200675886940 twice); since the column is
 * `@unique`, persisting the raw list throws and aborts the whole mirror. Pure.
 */
export function dedupeStatusHistory(history: SoStatusHistoryEntry[]): SoStatusHistoryEntry[] {
  const seen = new Set<string>();
  const out: SoStatusHistoryEntry[] = [];
  for (const h of history) {
    const id = String(h.iclassOsStatusId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out;
}
