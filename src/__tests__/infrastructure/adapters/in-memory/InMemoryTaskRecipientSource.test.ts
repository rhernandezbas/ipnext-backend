/**
 * bulk-task-recipients (B2.4, TASK-3) — InMemoryTaskRecipientSource: fixture of tasks
 * `{clientId, stageId, isClosed}` (a `clientId:null` row mirrors a network task,
 * TASK-3). Mirrors the Prisma adapter's contract: `stageId IN (...)`, `isClosed =
 * false`, `customerId != null`, DISTINCT for the resolver; the `customerId = null`
 * count is separate (`countOpenTasksWithoutCustomer`), never a silent drop.
 */
import { InMemoryTaskRecipientSource } from '@infrastructure/adapters/in-memory/InMemoryTaskRecipientSource';

describe('InMemoryTaskRecipientSource', () => {
  it('cliente con 5 tareas abiertas repartidas entre stageA y stageB → aparece UNA sola vez (distinct)', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c1', stageId: 'stageA', isClosed: false },
      { clientId: 'c1', stageId: 'stageA', isClosed: false },
      { clientId: 'c1', stageId: 'stageB', isClosed: false },
      { clientId: 'c1', stageId: 'stageB', isClosed: false },
      { clientId: 'c1', stageId: 'stageB', isClosed: false },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageA', 'stageB']);

    expect(result).toEqual(['c1']);
  });

  it('stage mapeado sin tareas abiertas → [], sin error', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c1', stageId: 'stageA', isClosed: false },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageC']);

    expect(result).toEqual([]);
  });

  it('tarea clientId:null en un stage pedido → NO aparece en listClientIdsByOpenTaskStages, SÍ la cuenta countOpenTasksWithoutCustomer', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: null, stageId: 'stageA', isClosed: false },
      { clientId: null, stageId: 'stageA', isClosed: false },
      { clientId: 'c2', stageId: 'stageA', isClosed: false },
    ]);

    const clientIds = await source.listClientIdsByOpenTaskStages(['stageA']);
    const noCustomerCount = await source.countOpenTasksWithoutCustomer(['stageA']);

    expect(clientIds).toEqual(['c2']);
    expect(noCustomerCount).toBe(2);
  });

  it('tarea isClosed:true, única tarea del cliente en el stage → cliente NO entra', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c3', stageId: 'stageA', isClosed: true },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageA']);

    expect(result).toEqual([]);
  });
});
