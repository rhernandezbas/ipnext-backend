import { OwnershipTransferCase } from '@domain/entities/ownershipCase';
import {
  OwnershipCaseRepository,
  CreateOwnershipCaseInput,
  OwnershipCasePatch,
  OwnershipCaseListFilter,
  OwnershipCaseListResult,
} from '@domain/ports/OwnershipCaseRepository';

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryOwnershipCaseRepository implements OwnershipCaseRepository {
  private cases: OwnershipTransferCase[] = [];
  private nextId = 1;

  private newId(): string {
    return `case-${String(this.nextId++).padStart(3, '0')}`;
  }

  // ─── Test helpers ────────────────────────────────────────────────────────────

  /** Reset state between tests. */
  reset(): void {
    this.cases = [];
    this.nextId = 1;
  }

  /** Seed a case directly (bypasses the unique guard — test helper). */
  seedCase(c: OwnershipTransferCase): void {
    this.cases.push(c);
  }

  // ─── Port implementations ────────────────────────────────────────────────────

  async existsBySourceContract(contractId: string): Promise<boolean> {
    return this.cases.some((c) => c.sourceContractId === contractId);
  }

  async create(input: CreateOwnershipCaseInput): Promise<OwnershipTransferCase> {
    // Mirrors the DB unique index on sourceContractId (P2002 in the Prisma adapter).
    if (this.cases.some((c) => c.sourceContractId === input.sourceContractId)) {
      throw new Error(`duplicate sourceContractId: ${input.sourceContractId}`);
    }

    const now = nowIso();
    const created: OwnershipTransferCase = {
      id: this.newId(),
      sourceContractId: input.sourceContractId,
      sourceClientId: input.sourceClientId,
      motivoBaja: input.motivoBaja,
      bajaDate: input.bajaDate ?? null,
      targetContractId: input.targetContractId ?? null,
      targetClientId: input.targetClientId ?? null,
      candidates: input.candidates ?? null,
      status: input.status,
      dismissReason: null,
      equipmentReviewed: false,
      equipmentReviewedById: null,
      equipmentReviewedAt: null,
      detectedAt: now,
      updatedAt: now,
    };
    this.cases.push(created);
    return created;
  }

  async getById(id: string): Promise<OwnershipTransferCase | null> {
    return this.cases.find((c) => c.id === id) ?? null;
  }

  async list(filter: OwnershipCaseListFilter): Promise<OwnershipCaseListResult> {
    let results = [...this.cases];
    if (filter.status) {
      results = results.filter((c) => c.status === filter.status);
    }

    // L7 — paridad con el adapter Prisma: detectedAt DESC, desempate id ASC.
    results.sort((a, b) =>
      new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime() ||
      a.id.localeCompare(b.id),
    );

    const total = results.length;
    const start = (filter.page - 1) * filter.pageSize;
    const items = results.slice(start, start + filter.pageSize);

    return { items, total };
  }

  /** Shape prístino — el MISMO predicado que usa el WHERE del CAS (updateIfPristine). */
  private static isPristine(c: OwnershipTransferCase): boolean {
    return (
      c.status === 'pending' &&
      c.targetContractId === null &&
      c.candidates === null &&
      !c.equipmentReviewed
    );
  }

  /** H1a — prístinos re-pareables: pending + sin target + sin candidates + sin review. FIFO. */
  async listPristineUnpaired(limit: number): Promise<OwnershipTransferCase[]> {
    return this.cases
      .filter((c) => InMemoryOwnershipCaseRepository.isPristine(c))
      .sort((a, b) =>
        new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime() ||
        a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }

  /**
   * Fix wave 2 — ids de origen ya caseados (cualquier status): el detector los
   * excluye del scan para que el cap drene (espejo del select fino Prisma).
   */
  async listAllSourceContractIds(): Promise<string[]> {
    return this.cases.map((c) => c.sourceContractId);
  }

  /** M1 — CAS: done SOLO si sigue pending+reviewed (espejo del updateMany condicional Prisma). */
  async flipToDone(id: string): Promise<boolean> {
    const idx = this.cases.findIndex(
      (c) => c.id === id && c.status === 'pending' && c.equipmentReviewed,
    );
    if (idx === -1) return false;

    this.cases[idx] = { ...this.cases[idx]!, status: 'done', updatedAt: nowIso() };
    return true;
  }

  /**
   * Fix wave 2 — CAS del re-pareo: aplica el patch SOLO si el caso sigue
   * prístino (espejo del updateMany condicional Prisma — re-chequea el shape
   * completo, no solo el id). false = alguien lo movió entre el listado y el
   * write; el caller lo salta sin resucitar ni pisar.
   */
  async updateIfPristine(id: string, patch: OwnershipCasePatch): Promise<boolean> {
    const current = this.cases.find((c) => c.id === id);
    if (!current || !InMemoryOwnershipCaseRepository.isPristine(current)) return false;

    await this.update(id, patch);
    return true;
  }

  async update(id: string, patch: OwnershipCasePatch): Promise<OwnershipTransferCase | null> {
    const idx = this.cases.findIndex((c) => c.id === id);
    if (idx === -1) return null;

    const current = this.cases[idx]!;
    const updated: OwnershipTransferCase = {
      ...current,
      ...(patch.targetContractId !== undefined && { targetContractId: patch.targetContractId }),
      ...(patch.targetClientId !== undefined && { targetClientId: patch.targetClientId }),
      ...(patch.candidates !== undefined && { candidates: patch.candidates }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.dismissReason !== undefined && { dismissReason: patch.dismissReason }),
      ...(patch.equipmentReviewed !== undefined && { equipmentReviewed: patch.equipmentReviewed }),
      ...(patch.equipmentReviewedById !== undefined && { equipmentReviewedById: patch.equipmentReviewedById }),
      ...(patch.equipmentReviewedAt !== undefined && { equipmentReviewedAt: patch.equipmentReviewedAt }),
      updatedAt: nowIso(),
    };
    this.cases[idx] = updated;
    return updated;
  }
}
