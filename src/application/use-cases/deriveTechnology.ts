import { classifyTech } from './classifyTech';

/**
 * Compute the effective technology for a contract at READ time.
 *
 * Rule: the manually-set technology ALWAYS wins.
 * When no manual value is stored, we derive it from the plan speed using
 * classifyTech and map FIBER → 'Fiber', WIRELESS → 'Wireless', UNCLASSIFIED → null.
 *
 * This is applied at the OUTPUT/DTO layer — the raw stored value on the
 * entity is preserved for filters and internal logic.
 *
 * @param technology - Stored technology value (manually set). Falsy = not set.
 * @param plan       - GR plan name (e.g. "300MB", "50/25MB", "TV").
 * @returns The effective technology string or null when it cannot be derived.
 */
export function deriveTechnology(
  technology: string | null | undefined,
  plan: string | null | undefined,
): string | null {
  if (technology) return technology;

  const cls = classifyTech(plan ?? null);
  if (cls === 'FIBER') return 'Fiber';
  if (cls === 'WIRELESS') return 'Wireless';
  return null;
}
