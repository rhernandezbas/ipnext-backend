import {
  AuditResult,
  AuditSeverity,
  AuditCategory,
  AUDIT_SEVERITIES,
  AUDIT_CATEGORIES,
} from '@domain/entities/installation-audit';

const SEV = new Set<string>(AUDIT_SEVERITIES);
const CAT = new Set<string>(AUDIT_CATEGORIES);

/**
 * Parses the auditor model's reply into an AuditResult. Extracts the first JSON
 * array, keeps only items with a valid severity+category+non-empty text, and
 * soft-fails to `{ ok: false }` on any parse/shape error (the use-case then
 * persists nothing). Pure; never throws.
 */
export function parseAuditResult(raw: string): AuditResult {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return { ok: false, findings: [] };
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return { ok: false, findings: [] };
    const findings = arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .filter(
        x => SEV.has(String(x.severity)) && CAT.has(String(x.category)) && typeof x.text === 'string' && x.text.trim().length > 0,
      )
      .map(x => ({
        severity: String(x.severity) as AuditSeverity,
        category: String(x.category) as AuditCategory,
        text: String(x.text).trim(),
        photoUrls: Array.isArray(x.photoUrls) ? (x.photoUrls.filter((u: unknown) => typeof u === 'string') as string[]) : [],
      }));
    return { ok: true, findings };
  } catch {
    return { ok: false, findings: [] };
  }
}
