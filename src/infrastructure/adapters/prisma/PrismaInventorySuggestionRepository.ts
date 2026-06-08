import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { prisma } from '../../database/prisma';

type Row = {
  id: string; taskId: string; kind: string; deviceType: string | null; qwenDeviceType: string | null;
  serialNumber: string | null; mac: string | null; materialDesc: string | null;
  quantity: number | null; unit: string | null; source: string; photoUrl: string | null;
  status: string; confirmedItemId: string | null; createdAt: Date;
};

function toEntity(r: Row): TaskInventorySuggestion {
  return {
    id: r.id, taskId: r.taskId, kind: r.kind as TaskInventorySuggestion['kind'],
    deviceType: r.deviceType, qwenDeviceType: r.qwenDeviceType, serialNumber: r.serialNumber, mac: r.mac, materialDesc: r.materialDesc,
    quantity: r.quantity, unit: r.unit, source: r.source, photoUrl: r.photoUrl,
    status: r.status as TaskInventorySuggestion['status'], confirmedItemId: r.confirmedItemId,
    createdAt: r.createdAt.toISOString(),
  };
}

export class PrismaInventorySuggestionRepository implements InventorySuggestionRepository {
  async listByTask(taskId: string): Promise<TaskInventorySuggestion[]> {
    const rows = await prisma.taskInventorySuggestion.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toEntity);
  }

  async hasDeviceForTask(taskId: string): Promise<boolean> {
    const row = await prisma.taskInventorySuggestion.findFirst({
      where: { taskId, kind: 'DEVICE', status: { not: 'discarded' } },
      select: { id: true },
    });
    return row !== null;
  }

  /** Natural-key upsert: (taskId, kind, source, serialNumber, mac, materialDesc).
   * El `source` fue incorporado para que el re-ingest de OCR no clobber filas MANUAL
   * que compartan SN/MAC. La idempotencia OCR↔OCR y MANUAL↔MANUAL se conserva.
   */
  async upsert(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion> {
    const existing = await prisma.taskInventorySuggestion.findFirst({
      where: {
        taskId: s.taskId, kind: s.kind, source: s.source,
        serialNumber: s.serialNumber, mac: s.mac, materialDesc: s.materialDesc,
      },
    });
    if (existing) {
      const row = await prisma.taskInventorySuggestion.update({
        where: { id: existing.id },
        data: {
          deviceType: s.deviceType, qwenDeviceType: s.qwenDeviceType, serialNumber: s.serialNumber, mac: s.mac,
          materialDesc: s.materialDesc, quantity: s.quantity, unit: s.unit, photoUrl: s.photoUrl,
        },
      });
      return toEntity(row);
    }
    const row = await prisma.taskInventorySuggestion.create({
      data: {
        id: s.id, taskId: s.taskId, kind: s.kind, deviceType: s.deviceType, qwenDeviceType: s.qwenDeviceType,
        serialNumber: s.serialNumber, mac: s.mac, materialDesc: s.materialDesc,
        quantity: s.quantity, unit: s.unit, source: s.source, photoUrl: s.photoUrl,
        status: s.status, confirmedItemId: s.confirmedItemId, createdAt: new Date(s.createdAt),
      },
    });
    return toEntity(row);
  }

  /** Plain insert sin dedup. Las sugerencias MANUAL nunca clobberizan filas OCR. */
  async create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion> {
    const row = await prisma.taskInventorySuggestion.create({
      data: {
        id: s.id, taskId: s.taskId, kind: s.kind, deviceType: s.deviceType,
        qwenDeviceType: s.qwenDeviceType, serialNumber: s.serialNumber, mac: s.mac,
        materialDesc: s.materialDesc, quantity: s.quantity, unit: s.unit,
        source: s.source, photoUrl: s.photoUrl,
        status: s.status, confirmedItemId: s.confirmedItemId,
        createdAt: new Date(s.createdAt),
      },
    });
    return toEntity(row);
  }

  async get(id: string): Promise<TaskInventorySuggestion | null> {
    const row = await prisma.taskInventorySuggestion.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async setStatus(
    id: string,
    status: TaskInventorySuggestion['status'],
    confirmedItemId?: string,
    deviceType?: string,
  ): Promise<TaskInventorySuggestion | null> {
    const existing = await prisma.taskInventorySuggestion.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await prisma.taskInventorySuggestion.update({
      where: { id },
      data: {
        status,
        confirmedItemId: confirmedItemId ?? existing.confirmedItemId,
        deviceType: deviceType ?? existing.deviceType,
      },
    });
    return toEntity(row);
  }
}
