/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` on Prisma calls because the Prisma client is generated
 * from the DB — the OwnershipTransferCase model appears after running
 * `prisma generate` post-migration. The casts are safe: the schema and columns
 * are correct (patrón PrismaRecaptureRepository).
 */
import { Prisma } from '@prisma/client';
import { OwnershipTransferCase } from '@domain/entities/ownershipCase';
import {
  OwnershipCaseRepository,
  CreateOwnershipCaseInput,
  OwnershipCasePatch,
  OwnershipCaseListFilter,
  OwnershipCaseListResult,
} from '@domain/ports/OwnershipCaseRepository';
import { prisma } from '../../database/prisma';

// ─── Row mapper ──────────────────────────────────────────────────────────────

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return (value as string | null) ?? null;
}

function toDomain(row: any): OwnershipTransferCase {
  return {
    id: row.id,
    sourceContractId: row.sourceContractId,
    sourceClientId: row.sourceClientId,
    motivoBaja: row.motivoBaja,
    bajaDate: row.bajaDate ?? null,
    targetContractId: row.targetContractId ?? null,
    targetClientId: row.targetClientId ?? null,
    candidates: (row.candidates as OwnershipTransferCase['candidates']) ?? null,
    status: row.status,
    dismissReason: row.dismissReason ?? null,
    equipmentReviewed: row.equipmentReviewed,
    equipmentReviewedById: row.equipmentReviewedById ?? null,
    equipmentReviewedAt: toIso(row.equipmentReviewedAt),
    detectedAt: toIso(row.detectedAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/**
 * Shared patch→data mapping for update/updateIfPristine — both writes MUST
 * serialize identically (Json columns: plain null is rejected — DbNull writes
 * SQL NULL, the same value the pristine WHERE matches with `equals: DbNull`).
 */
function patchToData(patch: OwnershipCasePatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.targetContractId !== undefined) data['targetContractId'] = patch.targetContractId;
  if (patch.targetClientId !== undefined) data['targetClientId'] = patch.targetClientId;
  if (patch.candidates !== undefined) {
    data['candidates'] = patch.candidates === null ? Prisma.DbNull : patch.candidates;
  }
  if (patch.status !== undefined) data['status'] = patch.status;
  if (patch.dismissReason !== undefined) data['dismissReason'] = patch.dismissReason;
  if (patch.equipmentReviewed !== undefined) data['equipmentReviewed'] = patch.equipmentReviewed;
  if (patch.equipmentReviewedById !== undefined) data['equipmentReviewedById'] = patch.equipmentReviewedById;
  if (patch.equipmentReviewedAt !== undefined) {
    data['equipmentReviewedAt'] = patch.equipmentReviewedAt === null ? null : new Date(patch.equipmentReviewedAt);
  }
  return data;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class PrismaOwnershipCaseRepository implements OwnershipCaseRepository {
  async existsBySourceContract(contractId: string): Promise<boolean> {
    const row = await (prisma as any).ownershipTransferCase.findUnique({
      where: { sourceContractId: contractId },
      select: { id: true },
    });
    return row !== null;
  }

  async create(input: CreateOwnershipCaseInput): Promise<OwnershipTransferCase> {
    const row = await (prisma as any).ownershipTransferCase.create({
      data: {
        sourceContractId: input.sourceContractId,
        sourceClientId: input.sourceClientId,
        motivoBaja: input.motivoBaja,
        bajaDate: input.bajaDate ?? null,
        targetContractId: input.targetContractId ?? null,
        targetClientId: input.targetClientId ?? null,
        // Omit when absent → column stays NULL (Json fields reject a plain null).
        candidates: input.candidates ?? undefined,
        status: input.status,
      },
    });
    return toDomain(row);
  }

  async getById(id: string): Promise<OwnershipTransferCase | null> {
    const row = await (prisma as any).ownershipTransferCase.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async list(filter: OwnershipCaseListFilter): Promise<OwnershipCaseListResult> {
    const where: Record<string, unknown> = {};
    if (filter.status) where['status'] = filter.status;

    const skip = (filter.page - 1) * filter.pageSize;

    const [rows, total] = await Promise.all([
      (prisma as any).ownershipTransferCase.findMany({
        where,
        skip,
        take: filter.pageSize,
        // L7 — orden estable con desempate (paridad con el InMemory).
        orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }],
      }),
      (prisma as any).ownershipTransferCase.count({ where }),
    ]);

    return { items: rows.map(toDomain), total };
  }

  /**
   * H1a — prístinos re-pareables por el detector: pending + sin target +
   * candidates SQL NULL + sin review manual. FIFO (detectedAt ASC) con cap.
   */
  async listPristineUnpaired(limit: number): Promise<OwnershipTransferCase[]> {
    const rows = await (prisma as any).ownershipTransferCase.findMany({
      where: {
        status: 'pending',
        targetContractId: null,
        // Json nullable: el filtro de columna NULL es DbNull (el adapter siempre
        // escribe DbNull para "sin candidates", nunca JSON null).
        candidates: { equals: Prisma.DbNull },
        equipmentReviewed: false,
      },
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toDomain);
  }

  /**
   * M1 — CAS flip a done: updateMany condicional {id, pending, reviewed} → el
   * count confirma que NADIE movió el caso entre la lectura y el flip (un
   * dismiss concurrente hace count 0 y el caller NO lo muestra done).
   */
  async flipToDone(id: string): Promise<boolean> {
    const result = await (prisma as any).ownershipTransferCase.updateMany({
      where: { id, status: 'pending', equipmentReviewed: true },
      data: { status: 'done' },
    });
    return result.count === 1;
  }

  /** Patch pattern from PrismaRecaptureRepository.assign: updateMany → count 0 = not found. */
  async update(id: string, patch: OwnershipCasePatch): Promise<OwnershipTransferCase | null> {
    const result = await (prisma as any).ownershipTransferCase.updateMany({
      where: { id },
      data: patchToData(patch),
    });
    if (result.count === 0) return null;

    const row = await (prisma as any).ownershipTransferCase.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  /**
   * Fix wave 2 — CAS del re-pareo: updateMany condicional sobre el shape
   * prístino COMPLETO (mismo WHERE que listPristineUnpaired, incl. candidates
   * `equals: DbNull` — el adapter siempre escribe SQL NULL para "sin
   * candidates": create omite el campo, update escribe DbNull; nunca JSON
   * null). count 0 = alguien movió el caso entre el listado y el write
   * (dismiss / set-target concurrente) → false, el caller lo salta.
   */
  async updateIfPristine(id: string, patch: OwnershipCasePatch): Promise<boolean> {
    const result = await (prisma as any).ownershipTransferCase.updateMany({
      where: {
        id,
        status: 'pending',
        targetContractId: null,
        candidates: { equals: Prisma.DbNull },
        equipmentReviewed: false,
      },
      data: patchToData(patch),
    });
    return result.count === 1;
  }

  /**
   * Fix wave 2 — ids de origen ya caseados (cualquier status) para excluir del
   * scan de titularidad (el cap drena). Select fino; bounded por titularidades
   * reales.
   */
  async listAllSourceContractIds(): Promise<string[]> {
    const rows = await (prisma as any).ownershipTransferCase.findMany({
      select: { sourceContractId: true },
    });
    return rows.map((r: { sourceContractId: string }) => r.sourceContractId);
  }
}
