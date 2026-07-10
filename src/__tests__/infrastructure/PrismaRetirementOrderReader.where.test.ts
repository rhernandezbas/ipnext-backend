/**
 * PrismaRetirementOrderReader — adapter intention tests with mocked Prisma client
 * (patrón PrismaPppoeServiceRepository.listAllWhere.test.ts). actions-worklist fix wave:
 *
 * M4 — sin falsos positivos: la pata por cliente SOLO matchea tasks SIN contrato
 * linkeado (`customerId` match AND `contractId IS NULL`). Una task de retiro de
 * OTRO contrato del mismo cliente ya no cuenta como orden de esta baja.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTask: {
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaRetirementOrderReader } from '../../infrastructure/adapters/prisma/PrismaRetirementOrderReader';

const mockPrisma = prisma as unknown as {
  scheduledTask: { findFirst: jest.Mock };
};

describe('PrismaRetirementOrderReader — hasRetirementTask WHERE shape (M4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.scheduledTask.findFirst.mockResolvedValue(null);
  });

  it('contrato + cliente: OR = [{contractId}, {customerId, contractId: null}] + join al project flag', async () => {
    const reader = new PrismaRetirementOrderReader();
    await reader.hasRetirementTask({ contractId: 'ct-1', clientId: 'cli-1' });

    const where = mockPrisma.scheduledTask.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      OR: [
        { contractId: 'ct-1' },
        { customerId: 'cli-1', contractId: null },
      ],
      project: { allowsEquipmentRetirement: true },
    });
  });

  it('solo contractId: OR con la única pata directa', async () => {
    const reader = new PrismaRetirementOrderReader();
    await reader.hasRetirementTask({ contractId: 'ct-1' });

    const where = mockPrisma.scheduledTask.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ contractId: 'ct-1' }]);
  });

  it('solo clientId: OR con la pata cliente restringida a tasks sin contrato', async () => {
    const reader = new PrismaRetirementOrderReader();
    await reader.hasRetirementTask({ clientId: 'cli-1' });

    const where = mockPrisma.scheduledTask.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ customerId: 'cli-1', contractId: null }]);
  });

  it('query vacía: NUNCA consulta (guard del OR vacío) y devuelve exists=false', async () => {
    const reader = new PrismaRetirementOrderReader();

    const result = await reader.hasRetirementTask({});

    expect(result).toEqual({ exists: false });
    expect(mockPrisma.scheduledTask.findFirst).not.toHaveBeenCalled();
  });

  it('match: devuelve exists=true con el taskId para linkear', async () => {
    mockPrisma.scheduledTask.findFirst.mockResolvedValue({ id: 'task-9' });
    const reader = new PrismaRetirementOrderReader();

    const result = await reader.hasRetirementTask({ contractId: 'ct-1' });

    expect(result).toEqual({ exists: true, taskId: 'task-9' });
  });
});
