/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';
import { prisma } from '../../database/prisma';

const d = (iso: string | null): Date | null => (iso ? new Date(iso) : null);
const big = (s: string | null): bigint | null => (s != null && s !== '' ? BigInt(s) : null);

export class PrismaClosedServiceOrderRepository implements ClosedServiceOrderRepository {
  async findSyncStateByIclassId(iclassId: string): Promise<{ iclassUpdatedAt: string | null } | null> {
    const row = await (prisma.iClassServiceOrder as any).findUnique({
      where: { iclassId: BigInt(iclassId) },
      select: { iclassUpdatedAt: true },
    });
    if (!row) return null;
    return { iclassUpdatedAt: row.iclassUpdatedAt ? row.iclassUpdatedAt.toISOString() : null };
  }

  async upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void> {
    const scalar = {
      iclassCodigo: order.iclassCodigo,
      clusterName: order.clusterName,
      thirdPartyCode: order.thirdPartyCode,
      nodeCode: order.nodeCode,
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
}
