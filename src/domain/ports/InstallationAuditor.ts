import { AuditContext, AuditResult } from '../entities/installation-audit';

/**
 * Audits the QUALITY of a closed installation from its full multimodal context
 * (photos + checklist text + task detail). MUST NOT throw — any failure (model
 * down, timeout, invalid output) resolves to `{ ok: false, findings: [] }`.
 */
export interface InstallationAuditor {
  /** Provider id persisted on the audit run, e.g. "ollama:qwen2.5vl:7b". */
  readonly provider: string;
  audit(context: AuditContext): Promise<AuditResult>;
}
