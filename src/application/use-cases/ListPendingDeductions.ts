import { MaterialDeductionSuggestionRepository } from '@domain/ports/MaterialDeductionSuggestionRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import {
  MaterialDeductionSuggestionDto,
  toMaterialDeductionSuggestionDto,
} from '@application/dto/MaterialDeductionSuggestionDto';
import { MaterialDeductionSuggestion } from '@domain/entities/material-deduction-suggestion';

/**
 * Read-only list of material deduction suggestions awaiting operator review (EPIC #38 W6):
 * status `pending` + `needs_review`. DTOs only — never raw entities.
 *
 * FIX 6: enriched with materialName/materialUnit (MaterialCatalog), technicianName
 * (RbacUser), taskSeq/taskTitle (SchedulingRepo) to match the FE contract.
 * Lookups are batched by unique ids to avoid per-row queries.
 */
export class ListPendingDeductions {
  constructor(
    private readonly deductions: MaterialDeductionSuggestionRepository,
    private readonly materials?: MaterialCatalogRepository,
    private readonly users?: RbacUserRepository,
    private readonly scheduling?: SchedulingRepository,
  ) {}

  async execute(): Promise<MaterialDeductionSuggestionDto[]> {
    const rows = await this.deductions.listPending();
    if (rows.length === 0) return [];

    // ── Batch lookups (avoid N+1) ──────────────────────────────────────────────
    const materialMap = await this.buildMaterialMap(rows);
    const userMap = await this.buildUserMap(rows);
    const taskMap = await this.buildTaskMap(rows);

    return rows.map((s) => {
      const mat = materialMap.get(s.materialCatalogId);
      const user = s.technicianId ? userMap.get(s.technicianId) : null;
      const task = taskMap.get(s.taskId);
      return toMaterialDeductionSuggestionDto(
        s,
        mat?.name ?? s.materialCatalogId,
        mat?.unit ?? null,
        user?.name ?? null,
        task?.sequenceNumber ?? null,
        task?.title ?? null,
      );
    });
  }

  private async buildMaterialMap(
    rows: MaterialDeductionSuggestion[],
  ): Promise<Map<string, { name: string; unit: string | null }>> {
    if (!this.materials) return new Map();
    const ids = [...new Set(rows.map((r) => r.materialCatalogId))];
    const entries = await Promise.all(ids.map((id) => this.materials!.getById(id)));
    const map = new Map<string, { name: string; unit: string | null }>();
    entries.forEach((m) => { if (m) map.set(m.id, { name: m.name, unit: m.unit ?? null }); });
    return map;
  }

  private async buildUserMap(
    rows: MaterialDeductionSuggestion[],
  ): Promise<Map<string, { name: string }>> {
    if (!this.users) return new Map();
    const ids = [...new Set(rows.map((r) => r.technicianId).filter(Boolean) as string[])];
    const entries = await Promise.all(ids.map((id) => this.users!.findById(id)));
    const map = new Map<string, { name: string }>();
    entries.forEach((u) => { if (u) map.set(u.id, { name: u.name }); });
    return map;
  }

  private async buildTaskMap(
    rows: MaterialDeductionSuggestion[],
  ): Promise<Map<string, { sequenceNumber: number; title: string }>> {
    if (!this.scheduling) return new Map();
    const ids = [...new Set(rows.map((r) => r.taskId).filter(Boolean) as string[])];
    const entries = await Promise.all(ids.map((id) => this.scheduling!.getTask(id)));
    const map = new Map<string, { sequenceNumber: number; title: string }>();
    entries.forEach((t) => { if (t) map.set(t.id, { sequenceNumber: t.sequenceNumber, title: t.title }); });
    return map;
  }
}
