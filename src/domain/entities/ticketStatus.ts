/**
 * Single source of truth for "closed-like" ticket status detection.
 *
 * Lección #46: NEVER hardcode a single literal and NEVER compare case-sensitively.
 * The known closed-like slugs match the editable catalog entries case-insensitively
 * ('closed' ↔ 'Closed'/'CLOSED', 'cerrado' ↔ 'Cerrado'). CloseTicket and ArchiveTicket
 * use these same slugs to resolve the catalog entry; the repositories use this helper
 * to decide whether a status transition should stamp or clear resolvedAt (#84).
 */
export const CLOSED_STATUS_SLUGS = ['closed', 'cerrado'] as const;

/** True when `status` is one of the known closed-like slugs (case-insensitive). */
export function isClosedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase();
  return (CLOSED_STATUS_SLUGS as readonly string[]).includes(normalized);
}
