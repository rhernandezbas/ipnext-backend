/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import {
  ClosedServiceOrderRepository,
  ClosureSideEffect,
  ClosureSideEffectState,
  PendingClosureSideEffects,
  PendingClosureSideEffectsWithTask,
} from '@domain/ports/ClosedServiceOrderRepository';
import { prisma } from '../../database/prisma';

const d = (iso: string | null): Date | null => (iso ? new Date(iso) : null);
const big = (s: string | null): bigint | null => (s != null && s !== '' ? BigInt(s) : null);
const iso = (dt: Date | null): string | null => (dt ? dt.toISOString() : null);
const str = (b: bigint | null): string | null => (b != null ? b.toString() : null);
const num = (v: unknown): number | null => (v != null ? Number(v) : null);

export class PrismaClosedServiceOrderRepository implements ClosedServiceOrderRepository {
  async findSyncStateByIclassId(
    iclassId: string,
  ): Promise<{ iclassUpdatedAt: string | null; closureAttemptedAt: string | null } | null> {
    const row = await (prisma.iClassServiceOrder as any).findUnique({
      where: { iclassId: BigInt(iclassId) },
      // FIX-B — closureAttemptedAt viaja en la MISMA lectura que el watermark: es la
      // query que el ingest ya hace justo antes de decidir si reporta la discrepancia.
      select: { iclassUpdatedAt: true, closureAttemptedAt: true },
    });
    if (!row) return null;
    return {
      iclassUpdatedAt: row.iclassUpdatedAt ? row.iclassUpdatedAt.toISOString() : null,
      closureAttemptedAt: row.closureAttemptedAt ? row.closureAttemptedAt.toISOString() : null,
    };
  }

  async upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void> {
    const scalar = {
      iclassCodigo: order.iclassCodigo,
      clusterName: order.clusterName,
      thirdPartyCode: order.thirdPartyCode,
      nodeCode: order.nodeCode,
      soTypeId: order.soTypeId,
      soTypeDescription: order.soTypeDescription,
      customerCode: order.customerCode,
      customerName: order.customerName,
      addressCode: order.addressCode,
      addressLine: order.addressLine,
      addressCity: order.addressCity,
      addressLat: order.addressLat,
      addressLng: order.addressLng,
      statusCode: order.statusCode,
      statusDescription: order.statusDescription,
      requestedAt: d(order.requestedAt),
      scheduledFor: d(order.scheduledFor),
      availableAt: d(order.availableAt),
      serviceStartedAt: d(order.serviceStartedAt),
      serviceEndedAt: d(order.serviceEndedAt),
      firstClosedAt: d(order.firstClosedAt),
      approvedAt: d(order.approvedAt),
      closedAt: d(order.closedAt),
      resultCodeName: order.resultCodeName,
      resultCodeType: order.resultCodeType,
      closedByLogin: order.closedByLogin,
      closedByName: order.closedByName,
      closeLatitude: order.closeLatitude,
      closeLongitude: order.closeLongitude,
      closeGpsAt: d(order.closeGpsAt),
      billingAmount: order.billingAmount,
      technicianNote: order.technicianNote,
      internalNote: order.internalNote,
      commentaryLog: order.commentaryLog,
      teamLogin: order.teamLogin,
      teamTechnicianName: order.teamTechnicianName,
      teamPhone: order.teamPhone,
      teamEmail: order.teamEmail,
      scheduledTaskId,
      iclassCreatedAt: d(order.iclassCreatedAt),
      iclassUpdatedAt: d(order.iclassUpdatedAt),
      rawDetail: order.rawDetail as any,
    };

    await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.iClassServiceOrder.findUnique({
        where: { iclassId: BigInt(order.iclassId) },
        select: { id: true },
      });

      let soId: string;
      if (existing) {
        soId = existing.id;
        await tx.iClassServiceOrder.update({ where: { id: soId }, data: scalar });
        // Replace children wholesale (cascade not needed — explicit deleteMany).
        await tx.iClassSoChecklistAnswer.deleteMany({ where: { checklist: { serviceOrderId: soId } } });
        await tx.iClassSoChecklist.deleteMany({ where: { serviceOrderId: soId } });
        await tx.iClassSoStatusHistory.deleteMany({ where: { serviceOrderId: soId } });
        await tx.iClassSoMaterial.deleteMany({ where: { serviceOrderId: soId } });
        await tx.iClassSoEquipmentEvent.deleteMany({ where: { serviceOrderId: soId } });
      } else {
        const created = await tx.iClassServiceOrder.create({
          data: { iclassId: BigInt(order.iclassId), ...scalar },
          select: { id: true },
        });
        soId = created.id;
      }

      if (order.history.length) {
        await tx.iClassSoStatusHistory.createMany({
          // skipDuplicates: belt-and-suspenders against IClass returning a
          // repeated transition (iclassOsStatusId is @unique). The use case also
          // dedupes upstream; this keeps the mirror safe for any direct caller.
          skipDuplicates: true,
          data: order.history.map(h => ({
            serviceOrderId: soId,
            iclassOsStatusId: BigInt(h.iclassOsStatusId),
            occurredAt: d(h.occurredAt) ?? new Date(0),
            statusCode: h.statusCode,
            statusDescription: h.statusDescription,
            durationMinutes: h.durationMinutes,
            teamLogin: h.teamLogin,
            commentary: h.commentary,
          })),
        });
      }
      for (const c of order.checklists) {
        await tx.iClassSoChecklist.create({
          data: {
            serviceOrderId: soId,
            iclassSurveyId: BigInt(c.iclassSurveyId),
            surveyAt: d(c.surveyAt),
            answers: {
              create: c.answers.map(a => ({
                questionId: big(a.questionId),
                questionText: a.questionText,
                questionType: a.questionType,
                answerOrder: a.answerOrder,
                answerText: a.answerText,
                photoMissing: a.photoMissing,
                photoUrl: a.photoUrl ?? null,
              })),
            },
          },
        });
      }
      if (order.materials.length) {
        await tx.iClassSoMaterial.createMany({
          data: order.materials.map(m => ({
            serviceOrderId: soId,
            iclassOsMaterialId: BigInt(m.iclassOsMaterialId),
            materialCode: m.materialCode,
            materialDescription: m.materialDescription,
            qty: m.qty,
            unitValue: m.unitValue,
            totalValue: m.totalValue,
          })),
        });
      }
      if (order.equipmentEvents.length) {
        await tx.iClassSoEquipmentEvent.createMany({
          data: order.equipmentEvents.map(e => ({
            serviceOrderId: soId,
            occurredAt: d(e.occurredAt),
            type: e.type,
            serialNumber: e.serialNumber,
            mac: e.mac,
            patrimonialNo: e.patrimonialNo,
            modelDescription: e.modelDescription,
          })),
        });
      }
    });
  }

  async getByIclassId(iclassId: string): Promise<ClosedServiceOrder | null> {
    const row = await (prisma.iClassServiceOrder as any).findUnique({
      where: { iclassId: BigInt(iclassId) },
      include: {
        history: true,
        checklists: { include: { answers: true } },
        materials: true,
        equipmentEvents: true,
      },
    });
    if (!row) return null;
    return {
      iclassId: row.iclassId.toString(),
      iclassCodigo: row.iclassCodigo,
      clusterName: row.clusterName,
      thirdPartyCode: row.thirdPartyCode,
      nodeCode: row.nodeCode,
      soTypeId: row.soTypeId,
      soTypeDescription: row.soTypeDescription,
      customerCode: row.customerCode,
      customerName: row.customerName,
      addressCode: row.addressCode,
      addressLine: row.addressLine,
      addressCity: row.addressCity,
      addressLat: row.addressLat,
      addressLng: row.addressLng,
      statusCode: row.statusCode,
      statusDescription: row.statusDescription,
      requestedAt: iso(row.requestedAt),
      scheduledFor: iso(row.scheduledFor),
      availableAt: iso(row.availableAt),
      serviceStartedAt: iso(row.serviceStartedAt),
      serviceEndedAt: iso(row.serviceEndedAt),
      resultCodeName: row.resultCodeName,
      closedByLogin: row.closedByLogin,
      closedByName: row.closedByName,
      closeLatitude: row.closeLatitude,
      closeLongitude: row.closeLongitude,
      closeGpsAt: iso(row.closeGpsAt),
      billingAmount: num(row.billingAmount),
      technicianNote: row.technicianNote,
      internalNote: row.internalNote,
      commentaryLog: row.commentaryLog,
      teamLogin: row.teamLogin,
      teamTechnicianName: row.teamTechnicianName,
      teamPhone: row.teamPhone,
      teamEmail: row.teamEmail,
      iclassCreatedAt: iso(row.iclassCreatedAt),
      iclassUpdatedAt: iso(row.iclassUpdatedAt),
      rawDetail: (row.rawDetail ?? {}) as Record<string, unknown>,
      // Derived fields persisted on the mirror.
      closedAt: iso(row.closedAt),
      firstClosedAt: iso(row.firstClosedAt),
      approvedAt: iso(row.approvedAt),
      resultCodeType: row.resultCodeType,
      history: (row.history ?? []).map((h: any) => ({
        iclassOsStatusId: h.iclassOsStatusId.toString(),
        occurredAt: iso(h.occurredAt),
        statusCode: h.statusCode,
        statusDescription: h.statusDescription,
        durationMinutes: h.durationMinutes,
        teamLogin: h.teamLogin,
        commentary: h.commentary,
      })),
      checklists: (row.checklists ?? []).map((c: any) => ({
        iclassSurveyId: c.iclassSurveyId.toString(),
        surveyAt: iso(c.surveyAt),
        answers: (c.answers ?? [])
          .slice()
          .sort((a: any, b: any) => a.answerOrder - b.answerOrder)
          .map((a: any) => ({
            questionId: str(a.questionId),
            questionText: a.questionText,
            questionType: a.questionType,
            answerOrder: a.answerOrder,
            answerText: a.answerText,
            photoMissing: a.photoMissing,
            photoUrl: a.photoUrl ?? null,
          })),
      })),
      materials: (row.materials ?? []).map((m: any) => ({
        iclassOsMaterialId: m.iclassOsMaterialId.toString(),
        materialCode: m.materialCode,
        materialDescription: m.materialDescription,
        qty: m.qty,
        unitValue: num(m.unitValue),
        totalValue: num(m.totalValue),
      })),
      equipmentEvents: (row.equipmentEvents ?? []).map((e: any) => ({
        occurredAt: iso(e.occurredAt),
        type: e.type,
        serialNumber: e.serialNumber,
        mac: e.mac,
        patrimonialNo: e.patrimonialNo,
        modelDescription: e.modelDescription,
      })),
    };
  }

  async getSideEffectState(iclassId: string): Promise<ClosureSideEffectState | null> {
    const row = await (prisma.iClassServiceOrder as any).findUnique({
      where: { iclassId: BigInt(iclassId) },
      select: {
        commentPosted: true,
        inventoryBuilt: true,
        auditDone: true,
        auditAttempts: true,
        inventoryReturnsProcessed: true,
      },
    });
    if (!row) return null;
    return {
      commentPosted: row.commentPosted,
      inventoryBuilt: row.inventoryBuilt,
      auditDone: row.auditDone,
      auditAttempts: row.auditAttempts,
      inventoryReturnsProcessed: row.inventoryReturnsProcessed,
    };
  }

  async listPendingSideEffects(maxAuditAttempts: number): Promise<PendingClosureSideEffects[]> {
    const rows = await (prisma.iClassServiceOrder as any).findMany({
      // NOTE: inventoryReturnsProcessed is intentionally NOT in this OR. A non-retiro
      // SO legitimately keeps it false forever, so including it would flood the
      // reprocess list with every non-retiro closure. Returns re-eval for unchanged
      // SOs runs through the closure skippedUnchanged path (REQ-IDEMP-1), not here.
      // Two independent OR groups MUST be composed via AND — a single `where`
      // object cannot hold two `OR` keys (they'd collide), and we need BOTH the
      // pending-side-effect filter AND the dismissed exclusion to apply.
      where: {
        AND: [
          {
            OR: [
              { commentPosted: false },
              { inventoryBuilt: false },
              { auditDone: false, auditAttempts: { lt: maxAuditAttempts } },
            ],
          },
          // #41 F1 — exclude SOs whose linked task is dismissed (the operator discarded it;
          // its side-effects must not be reprocessed nor shown in the FE progress table).
          //
          // WHY the explicit OR with the scheduledTaskId:null leg, and NOT a bare
          // `NOT: { scheduledTask: { generalStatus: 'dismissed' } }`:
          // under Prisma 1:1 (to-one) semantics a relation filter on a NULL relation
          // is FALSE, so `NOT {...}` would also be false for null-task rows and would
          // silently DROP them (prisma/prisma#25226). Null-task mirrors are real
          // (scheduledTask onDelete: SetNull + task deletion), and in-memory parity
          // (isDismissed → false when scheduledTaskId is null) KEEPS them. Truth table:
          //   - null-task      → leg 1 (scheduledTaskId: null) TRUE          → kept
          //   - task=dismissed → leg 1 false, leg 2 false                    → excluded
          //   - task=other     → leg 2 (generalStatus not 'dismissed') TRUE  → kept
          {
            OR: [
              { scheduledTaskId: null },
              { scheduledTask: { generalStatus: { not: 'dismissed' } } },
            ],
          },
        ],
      },
      select: {
        iclassId: true,
        scheduledTaskId: true,
        commentPosted: true,
        inventoryBuilt: true,
        auditDone: true,
        auditAttempts: true,
        inventoryReturnsProcessed: true,
      },
    });
    return rows.map((r: any) => ({
      iclassId: r.iclassId.toString(),
      scheduledTaskId: r.scheduledTaskId,
      commentPosted: r.commentPosted,
      inventoryBuilt: r.inventoryBuilt,
      auditDone: r.auditDone,
      auditAttempts: r.auditAttempts,
      inventoryReturnsProcessed: r.inventoryReturnsProcessed,
    }));
  }

  async listPendingSideEffectsWithTask(maxAuditAttempts: number): Promise<PendingClosureSideEffectsWithTask[]> {
    const rows = await (prisma.iClassServiceOrder as any).findMany({
      // #41 F1 — same AND-composed dismissed exclusion as listPendingSideEffects
      // (parity). See that method's comment for the 1:1-relation truth table and
      // why the explicit scheduledTaskId:null leg is required.
      where: {
        AND: [
          {
            OR: [
              { commentPosted: false },
              { inventoryBuilt: false },
              { auditDone: false, auditAttempts: { lt: maxAuditAttempts } },
            ],
          },
          {
            OR: [
              { scheduledTaskId: null },
              { scheduledTask: { generalStatus: { not: 'dismissed' } } },
            ],
          },
        ],
      },
      select: {
        iclassId: true,
        scheduledTaskId: true,
        commentPosted: true,
        inventoryBuilt: true,
        auditDone: true,
        auditAttempts: true,
        inventoryReturnsProcessed: true,
        scheduledTask: {
          select: { id: true, sequenceNumber: true, title: true },
        },
      },
    });
    return rows.map((r: any) => ({
      iclassId: r.iclassId.toString(),
      scheduledTaskId: r.scheduledTaskId,
      commentPosted: r.commentPosted,
      inventoryBuilt: r.inventoryBuilt,
      auditDone: r.auditDone,
      auditAttempts: r.auditAttempts,
      inventoryReturnsProcessed: r.inventoryReturnsProcessed,
      task: r.scheduledTask
        ? { id: r.scheduledTask.id, sequenceNumber: r.scheduledTask.sequenceNumber, title: r.scheduledTask.title }
        : null,
    }));
  }

  async markSideEffect(iclassId: string, effect: ClosureSideEffect, done: boolean): Promise<void> {
    await (prisma.iClassServiceOrder as any).update({
      where: { iclassId: BigInt(iclassId) },
      data: { [effect]: done },
    });
  }

  /**
   * FIX-B (fix wave 2 W1a) — sella el PRIMER intento de cierre. `updateMany` con
   * `closureAttemptedAt: null` en el WHERE: la escritura es condicional en la misma
   * sentencia, así que un segundo tick (o dos crons solapados) no puede correr el
   * timestamp hacia adelante — mismo patrón de guard que `closeTaskIfOpen`, por la misma
   * razón: si el sello se moviera, el gate "reportá una sola vez" volvería a ser un
   * "reportá siempre". No-op cuando la OS no está espejada (0 filas).
   */
  async markClosureAttempted(iclassId: string): Promise<void> {
    await (prisma.iClassServiceOrder as any).updateMany({
      where: { iclassId: BigInt(iclassId), closureAttemptedAt: null },
      data: { closureAttemptedAt: new Date() },
    });
  }

  async markInventoryReturnsProcessed(iclassId: string): Promise<void> {
    await (prisma.iClassServiceOrder as any).update({
      where: { iclassId: BigInt(iclassId) },
      data: { inventoryReturnsProcessed: true },
    });
  }

  async incrementAuditAttempt(iclassId: string): Promise<void> {
    await (prisma.iClassServiceOrder as any).update({
      where: { iclassId: BigInt(iclassId) },
      data: { auditAttempts: { increment: 1 }, lastAuditAttemptAt: new Date() },
    });
  }
}
