/**
 * TDD — fix wave W1a / FIX-1 (use-case level) — cerrar → reabrir deja los 4 campos de
 * cierre en null, sea cual sea la puerta que se use.
 *
 * El fix vive en el adapter (donde se traduce el update), pero el contrato que le
 * importa al producto es el de arriba: el endpoint dedicado de estado
 * (`SetTaskGeneralStatus`) y el PUT genérico (`UpdateTask`, incluida la vía legacy
 * `isClosed:false`). Un test que sólo mire el repo no prueba que la ruta llegue ahí.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ProjectKindLookup } from '@domain/ports/ProjectKindLookup';

const STAGE = '10000000-0000-4000-a000-000000000001';

const emptyLookup: EntityLookup = { findById: async () => null };
const projectLookup: ProjectKindLookup = { findById: async () => null };

const CREATE_INPUT = {
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
};

async function seedClosed(repo: InMemorySchedulingRepository) {
  const task = await repo.createTask(CREATE_INPUT);
  const r = await repo.closeTaskIfOpen(task.id, { origin: 'iclass', resultCode: 'INSTALACION_OK', closedByUserId: 'u-1' });
  // PRESENCE before ABSENCE — sin esto el test pasaría contra un mundo donde el cierre
  // nunca escribió nada (memoria: "probe de ausencia no discrimina").
  expect(r.task!.closureOrigin).toBe('iclass');
  expect(repo.getClosureDetails(task.id)).not.toBeNull();
  return task;
}

describe('FIX-1 — reopen limpia los campos de cierre (use case)', () => {
  it('SetTaskGeneralStatus closed → open: closureOrigin null + detalles borrados + status_changed', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const task = await seedClosed(repo);

    const uc = new SetTaskGeneralStatus(repo, recorder);
    const reopened = await uc.execute(task.id, 'open', { actorId: 'u-9', actorName: 'Staff' });

    expect(reopened.generalStatus).toBe('open');
    expect(reopened.isClosed).toBe(false);
    expect(reopened.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
    expect(recorder.calls.filter(c => c.type === 'status_changed')).toHaveLength(1);
  });

  it('SetTaskGeneralStatus closed → dismissed también limpia', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosed(repo);

    const uc = new SetTaskGeneralStatus(repo);
    const dismissed = await uc.execute(task.id, 'dismissed');

    expect(dismissed.generalStatus).toBe('dismissed');
    expect(dismissed.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('UpdateTask con generalStatus:\'open\' limpia (PUT genérico)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosed(repo);

    const uc = new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, projectLookup);
    const reopened = await uc.execute(task.id, { generalStatus: 'open' });

    expect(reopened!.generalStatus).toBe('open');
    expect(reopened!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('UpdateTask con la vía legacy isClosed:false limpia igual (la CLASE, no la instancia)', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await seedClosed(repo);

    const uc = new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, projectLookup);
    const reopened = await uc.execute(task.id, { isClosed: false });

    expect(reopened!.generalStatus).toBe('open');
    expect(reopened!.closureOrigin).toBeNull();
    expect(repo.getClosureDetails(task.id)).toBeNull();
  });

  it('reabrir y volver a cerrar por OTRO origen deja el origen NUEVO (no el viejo pegado)', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const task = await seedClosed(repo);
    const uc = new SetTaskGeneralStatus(repo, recorder);

    await uc.execute(task.id, 'open', { actorId: 'u-9', actorName: 'Staff' });
    const reclosed = await uc.execute(task.id, 'closed', { actorId: 'u-9', actorName: 'Staff' });

    expect(reclosed.closureOrigin).toBe('staff');
    expect(repo.getClosureDetails(task.id)).toEqual({
      resultCode: null,
      closedByUserId: 'u-9',
      closedAt: expect.any(String),
    });
  });
});
