/**
 * TDD — fix wave W1a / FIX-1 — reopening a task CLEARS the four closure columns.
 *
 * `closeTaskIfOpen` stamps closureOrigin/closureResultCode/closedAt/closedByUserId.
 * Nothing was clearing them again: a task closed by iclass and then reopened by an
 * operator kept `closureOrigin='iclass'` + a `closedAt` in the past while being
 * `generalStatus='open'` — a lie in the audit trail AND a spec violation
 * ("closureOrigin MUST be null unless generalStatus === 'closed'").
 *
 * The fix lives where the update is TRANSLATED (updateTask / _buildUpdateData), not
 * in one use case, so it covers the whole CLASS: the dedicated status endpoint, the
 * generic PUT, the legacy `isClosed:false` compat path, and a close→dismissed move.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

const STAGE = '10000000-0000-4000-a000-000000000001';

async function seedClosedTask(repo: InMemorySchedulingRepository) {
  const task = await repo.createTask({
    title: 'Instalación',
    description: null,
    stageId: STAGE,
    priority: 'normal',
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'other',
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    contractId: null,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    travelTimeTo: null,
    travelTimeFrom: null,
  });
  const closed = await repo.closeTaskIfOpen(task.id, {
    origin: 'iclass',
    resultCode: 'INSTALACION_OK',
    closedByUserId: 'u-42',
  });
  expect(closed.closed).toBe(true);
  // PRESENCE first — a test that only asserts the later ABSENCE would pass against a
  // world where these were never written at all (memory: "probe de ausencia no discrimina").
  expect(closed.task!.closureOrigin).toBe('iclass');
  expect(repo.getClosureDetails(task.id)).toEqual({
    resultCode: 'INSTALACION_OK',
    closedByUserId: 'u-42',
    closedAt: expect.any(String),
  });
  return task;
}

describe('InMemorySchedulingRepository — reopen clears the closure columns (FIX-1)', () => {
  it('generalStatus closed → open: the 4 closure fields go back to null', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosedTask(repo);

    const reopened = await repo.updateTask(task.id, { generalStatus: 'open' });

    expect(reopened!.generalStatus).toBe('open');
    expect(reopened!.isClosed).toBe(false);
    expect(reopened!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('legacy compat path `isClosed:false` clears them too (same class of transition)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosedTask(repo);

    const reopened = await repo.updateTask(task.id, { isClosed: false });

    expect(reopened!.generalStatus).toBe('open');
    expect(reopened!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('closed → dismissed also clears them (ANY transition out of closed)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosedTask(repo);

    const dismissed = await repo.updateTask(task.id, { generalStatus: 'dismissed' });

    expect(dismissed!.generalStatus).toBe('dismissed');
    expect(dismissed!.isClosed).toBe(false);
    expect(dismissed!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('an update that does NOT touch generalStatus preserves the closure fields', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosedTask(repo);

    const patched = await repo.updateTask(task.id, { title: 'Instalación (corregida)' });

    expect(patched!.title).toBe('Instalación (corregida)');
    expect(patched!.generalStatus).toBe('closed');
    expect(patched!.closureOrigin).toBe('iclass');
    expect(repo.getClosureDetails(task.id)?.resultCode).toBe('INSTALACION_OK');
  });

  it('re-closing after a reopen stamps the NEW origin, not the stale one', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosedTask(repo);
    await repo.updateTask(task.id, { generalStatus: 'open' });

    const reclosed = await repo.closeTaskIfOpen(task.id, { origin: 'staff', resultCode: 'CANCELADA', closedByUserId: 'u-7' });

    expect(reclosed.closed).toBe(true);
    expect(reclosed.task!.closureOrigin).toBe('staff');
    expect(repo.getClosureDetails(task.id)).toEqual({
      resultCode: 'CANCELADA',
      closedByUserId: 'u-7',
      closedAt: expect.any(String),
    });
  });
});
