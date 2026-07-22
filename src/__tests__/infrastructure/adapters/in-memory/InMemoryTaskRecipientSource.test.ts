/**
 * bulk-task-recipients (B2.4, TASK-3) — InMemoryTaskRecipientSource: fixture of tasks
 * `{clientId, stageId, isClosed, generalStatus}` (a `clientId:null` row mirrors a
 * network task, TASK-3). Mirrors the Prisma adapter's contract: `stageId IN (...)`,
 * `generalStatus = 'open'`, `customerId != null`, DISTINCT for the resolver; the
 * `customerId = null` count is separate (`countOpenTasksWithoutCustomer`), never a
 * silent drop.
 *
 * fix wave (F1, HIGH) — el filtro real usa `generalStatus === 'open'`, NUNCA el
 * flag legacy `isClosed` (una tarea `generalStatus:'dismissed'` tiene
 * `isClosed === false` — `messaging.ts:227-228`, mismo criterio que
 * `PrismaFiberAutoProvisionTaskRepository.ts:16`). `isClosed` se conserva en el
 * fixture porque SIGUE siendo parte de la fila real (derivado, sincronizado en
 * cada write) — pero el filtro NUNCA lo mira.
 */
import { InMemoryTaskRecipientSource } from '@infrastructure/adapters/in-memory/InMemoryTaskRecipientSource';

describe('InMemoryTaskRecipientSource', () => {
  it('cliente con 5 tareas abiertas repartidas entre stageA y stageB → aparece UNA sola vez (distinct)', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c1', stageId: 'stageA', isClosed: false, generalStatus: 'open' },
      { clientId: 'c1', stageId: 'stageA', isClosed: false, generalStatus: 'open' },
      { clientId: 'c1', stageId: 'stageB', isClosed: false, generalStatus: 'open' },
      { clientId: 'c1', stageId: 'stageB', isClosed: false, generalStatus: 'open' },
      { clientId: 'c1', stageId: 'stageB', isClosed: false, generalStatus: 'open' },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageA', 'stageB']);

    expect(result).toEqual(['c1']);
  });

  it('stage mapeado sin tareas abiertas → [], sin error', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c1', stageId: 'stageA', isClosed: false, generalStatus: 'open' },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageC']);

    expect(result).toEqual([]);
  });

  it('tarea clientId:null en un stage pedido → NO aparece en listClientIdsByOpenTaskStages, SÍ la cuenta countOpenTasksWithoutCustomer', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: null, stageId: 'stageA', isClosed: false, generalStatus: 'open' },
      { clientId: null, stageId: 'stageA', isClosed: false, generalStatus: 'open' },
      { clientId: 'c2', stageId: 'stageA', isClosed: false, generalStatus: 'open' },
    ]);

    const clientIds = await source.listClientIdsByOpenTaskStages(['stageA']);
    const noCustomerCount = await source.countOpenTasksWithoutCustomer(['stageA']);

    expect(clientIds).toEqual(['c2']);
    expect(noCustomerCount).toBe(2);
  });

  it('tarea isClosed:true (generalStatus:closed), única tarea del cliente en el stage → cliente NO entra', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c3', stageId: 'stageA', isClosed: true, generalStatus: 'closed' },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageA']);

    expect(result).toEqual([]);
  });

  it('fix wave (F1, HIGH) — tarea DESCARTADA (generalStatus:dismissed, isClosed:false) → cliente NO entra (isClosed engañoso)', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: 'c4', stageId: 'stageA', isClosed: false, generalStatus: 'dismissed' },
    ]);

    const result = await source.listClientIdsByOpenTaskStages(['stageA']);

    expect(result).toEqual([]);
  });

  it('fix wave (F1, HIGH) — tarea de red DESCARTADA (generalStatus:dismissed, isClosed:false) → NO cuenta en countOpenTasksWithoutCustomer', async () => {
    const source = new InMemoryTaskRecipientSource([
      { clientId: null, stageId: 'stageA', isClosed: false, generalStatus: 'dismissed' },
      { clientId: null, stageId: 'stageA', isClosed: false, generalStatus: 'open' },
    ]);

    const noCustomerCount = await source.countOpenTasksWithoutCustomer(['stageA']);

    expect(noCustomerCount).toBe(1);
  });
});
