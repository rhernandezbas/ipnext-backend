/**
 * TDD — fix wave 2 W1a / FIX-C — el REOPEN preserva el sello de cierre en la activity.
 *
 * FIX-1 hizo lo correcto: toda transición a un `generalStatus` distinto de `'closed'`
 * limpia las cuatro columnas de cierre (`closureOrigin`, `closureResultCode`,
 * `closedAt`, `closedByUserId`). Pero las BORRA sin dejar rastro: después de reabrir,
 * "quién cerró esto y con qué resultado" deja de existir en el sistema. La auditoría
 * que la wave entera existe para construir se pierde justo en el evento más
 * interesante — cuando alguien deshace un cierre.
 *
 * El `status_changed` que ya se emite en ese momento es el lugar natural del sello: la
 * tabla de activities es append-only, así que lo que se guarda ahí no lo pisa nadie.
 *
 * Se cubren LOS DOS escritores de reopen (la clase, no la instancia — memoria: "fix
 * wave: buscar el hermano"): `SetTaskGeneralStatus` (endpoint dedicado) y `UpdateTask`
 * (PUT genérico, incluida la vía legacy `isClosed: false`).
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { applyTaskClosure } from '@application/use-cases/applyTaskClosure';
import { readClearedClosureStamp } from '@application/use-cases/reopenClosureStamp';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ClosureStamp } from '@domain/ports/SchedulingRepository';

const ACTOR = { actorId: 'user-77', actorName: 'Operadora' };

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

/** Cierra `t1` de verdad (por el guard atómico) y devuelve el sello que quedó. */
async function seedClosed(repo: InMemorySchedulingRepository, id = 't1') {
  repo.seedTask({ id, generalStatus: 'open', isClosed: false });
  await applyTaskClosure(repo, undefined, {
    taskId: id,
    origin: 'iclass',
    resultCode: 'Instalacion Completa Fibra',
    closedByUserId: 'u-9',
  });
  const details = repo.getClosureDetails(id);
  expect(details).not.toBeNull(); // presencia antes que ausencia: el sello EXISTE antes del reopen
  return details!;
}

/** El único `status_changed` emitido (single o batched), o undefined. */
function statusChanged(recorder: FakeTaskActivityRecorder) {
  const single = recorder.calls.filter(c => c.type === 'status_changed');
  const batched = recorder.manyCalls.flatMap(m => m.events.filter(e => e.type === 'status_changed'));
  const all = [...single.map(c => c.payload), ...batched];
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('FIX-C — SetTaskGeneralStatus: el status_changed del reopen lleva el sello borrado', () => {
  it.each(['open', 'dismissed'] as const)('closed → %s: metadata.clearedClosure trae las cuatro columnas', async (target) => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const stamp = await seedClosed(repo);

    await new SetTaskGeneralStatus(repo, recorder).execute('t1', target, ACTOR);

    const ev = statusChanged(recorder);
    expect(ev.fromValue).toBe('closed');
    expect(ev.toValue).toBe(target);
    expect(ev.metadata).toMatchObject({
      clearedClosure: {
        closureOrigin: 'iclass',
        closureResultCode: 'Instalacion Completa Fibra',
        closedAt: stamp.closedAt,
        closedByUserId: 'u-9',
      },
    });
    // Y el sello YA NO está en la tarea (FIX-1 sigue vigente): la activity es el único rastro.
    expect(repo.getClosureDetails('t1')).toBeNull();
    expect((await repo.getTask('t1'))!.closureOrigin).toBeNull();
  });

  it('CONTRASTE: una transición que NO es reopen (open → dismissed) no inventa clearedClosure', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    repo.seedTask({ id: 't1', generalStatus: 'open', isClosed: false });

    await new SetTaskGeneralStatus(repo, recorder).execute('t1', 'dismissed', ACTOR);

    const ev = statusChanged(recorder);
    expect(ev.metadata ?? null).toBeNull(); // ni un objeto con cuatro nulls: NADA
  });
});

/**
 * ── MEDIUM-1 (fix wave 3 W1a) — el SELLO VACÍO no se emite ────────────────────────
 *
 * El docstring de `readClearedClosureStamp` prometía null "cuando es una fila legacy sin
 * sello", y el spec lo fija: "cuando la tarea es una fila legacy sin sello el evento NO
 * lleva metadata". El código NO lo cumplía: devolvía tal cual lo que da el adapter, que
 * para una fila PRE-migración es un objeto con las CUATRO columnas en null. Eso viaja al
 * `status_changed` como `clearedClosure: {null,null,null,null}` — que es exactamente lo
 * que el comentario dice que hay que evitar: "cerrada por nadie" en vez de "no hay dato".
 *
 * El fixture era cómplice: `seedTask` SIEMPRE poblaba `closedAt` para una tarea sembrada
 * cerrada, así que el in-memory no podía exhibir la fila de cuatro nulls que Postgres sí
 * produce. Se habilita explícitamente con `{ legacyClosure: true }` (el default no cambia).
 */
describe('MEDIUM-1 — una fila LEGACY (cuatro nulls) reabre SIN metadata', () => {
  it('in-memory: seedTask legacyClosure → el status_changed del reopen no lleva clearedClosure', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    repo.seedTask({ id: 't1', generalStatus: 'closed', isClosed: true }, { legacyClosure: true });

    // Presencia antes que ausencia: la fila legacy EXISTE y es exactamente la de 4 nulls.
    expect((await repo.getTask('t1'))!.generalStatus).toBe('closed');
    expect(repo.getClosureDetails('t1')).toBeNull();
    expect(await repo.getClosureStamp('t1')).toEqual({
      closureOrigin: null, closureResultCode: null, closedAt: null, closedByUserId: null,
    });

    await new SetTaskGeneralStatus(repo, recorder).execute('t1', 'open', ACTOR);

    const ev = statusChanged(recorder);
    expect(ev.fromValue).toBe('closed');
    expect(ev.toValue).toBe('open');
    expect(ev.metadata ?? null).toBeNull(); // ni un objeto con cuatro nulls: NADA
  });

  it('camino PRISMA (mock coherente con lo que devuelve el adapter para una fila legacy)', async () => {
    // `PrismaSchedulingRepository.getClosureStamp` sobre una fila pre-migración devuelve
    // este objeto exacto: la fila está `closed` (no da null) pero las cuatro columnas
    // nuevas nunca se escribieron. Se calca en un adapter que por lo demás es el real.
    const PRISMA_LEGACY_STAMP: ClosureStamp = {
      closureOrigin: null, closureResultCode: null, closedAt: null, closedByUserId: null,
    };
    class PrismaLegacyShapeRepo extends InMemorySchedulingRepository {
      async getClosureStamp(): Promise<ClosureStamp | null> { return { ...PRISMA_LEGACY_STAMP }; }
    }
    const repo = new PrismaLegacyShapeRepo();
    const recorder = new FakeTaskActivityRecorder();
    repo.seedTask({ id: 't1', generalStatus: 'closed', isClosed: true }, { legacyClosure: true });
    expect(await repo.getClosureStamp()).toEqual(PRISMA_LEGACY_STAMP); // presencia del shape

    await new SetTaskGeneralStatus(repo, recorder).execute('t1', 'open', ACTOR);

    expect(statusChanged(recorder).metadata ?? null).toBeNull();
  });

  it('UpdateTask (el hermano) sobre una fila legacy tampoco inventa clearedClosure', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    repo.seedTask({ id: 't1', generalStatus: 'closed', isClosed: true }, { legacyClosure: true });
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any, recorder).execute('t1', { isClosed: false }, ACTOR);

    expect(statusChanged(recorder).metadata ?? null).toBeNull();
  });

  it('el helper devuelve null para el sello vacío y PRESERVA cualquier sello con un dato', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'legacy', generalStatus: 'closed', isClosed: true }, { legacyClosure: true });
    expect(await readClearedClosureStamp(repo, 'legacy', 'closed', 'open')).toBeNull();

    // CONTRASTE: un sello con UN SOLO campo poblado NO es vacío — no se descarta.
    repo.seedTask({ id: 'parcial', generalStatus: 'closed', isClosed: true });
    const parcial = await readClearedClosureStamp(repo, 'parcial', 'closed', 'open');
    expect(parcial).not.toBeNull();
    expect(typeof parcial!.closedAt).toBe('string');
  });
});

describe('FIX-C — UpdateTask (PUT genérico): el hermano del mismo defecto', () => {
  it('generalStatus: open sobre una tarea cerrada → clearedClosure en el status_changed', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const stamp = await seedClosed(repo);
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any, recorder).execute('t1', { generalStatus: 'open' }, ACTOR);

    expect(statusChanged(recorder).metadata).toMatchObject({
      clearedClosure: {
        closureOrigin: 'iclass',
        closureResultCode: 'Instalacion Completa Fibra',
        closedAt: stamp.closedAt,
        closedByUserId: 'u-9',
      },
    });
  });

  it('la vía LEGACY isClosed: false también preserva el sello', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    const stamp = await seedClosed(repo);
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any, recorder).execute('t1', { isClosed: false }, ACTOR);

    expect(statusChanged(recorder).metadata).toMatchObject({
      clearedClosure: { closureOrigin: 'iclass', closedAt: stamp.closedAt, closedByUserId: 'u-9' },
    });
  });

  it('CONTRASTE: un patch que NO toca el estado no emite status_changed ni clearedClosure', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeTaskActivityRecorder();
    await seedClosed(repo);
    const any = new AnyLookup();

    await new UpdateTask(repo, any, any, any, any, any, recorder).execute('t1', { notes: 'una nota' }, ACTOR);

    const types = recorder.allTypes;
    expect(types).toContain('notes_changed'); // presencia: el update corrió
    expect(types).not.toContain('status_changed');
  });
});
