import { AuditFinding, AuditSeverity, AuditCategory } from '@domain/entities/installation-audit';

export interface AuditFindingDto {
  id: string;
  severity: AuditSeverity;
  category: AuditCategory;
  text: string;
  photoUrls: string[];
  createdAt: string;
}

export function toAuditFindingDto(f: AuditFinding): AuditFindingDto {
  return { id: f.id, severity: f.severity, category: f.category, text: f.text, photoUrls: f.photoUrls, createdAt: f.createdAt };
}
