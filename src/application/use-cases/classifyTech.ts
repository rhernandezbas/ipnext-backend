/**
 * Connection technology classification for Gestión Real plan names.
 *
 * The plan name's FIRST integer is treated as the download speed (Mbps):
 *   - ≥ 100  → FIBER
 *   - < 100  → WIRELESS
 *   - no integer (or null/empty) → UNCLASSIFIED (needs manual review)
 *
 * Examples: "300MB" → FIBER, "100" → FIBER, "50/25MB" → WIRELESS,
 * "20/5MB GRAL" → WIRELESS (speed 20), "FIBRA"/""/null → UNCLASSIFIED.
 *
 * Pure function — no side effects, no I/O.
 */
export type TechClass = 'FIBER' | 'WIRELESS' | 'UNCLASSIFIED';

export function classifyTech(plan: string | null): TechClass {
  const match = (plan ?? '').match(/\d+/);
  if (!match) return 'UNCLASSIFIED';
  const speed = parseInt(match[0], 10);
  return speed >= 100 ? 'FIBER' : 'WIRELESS';
}
