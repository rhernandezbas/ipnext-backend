/**
 * TDD — fix wave W1a / FIX-4 — SEMÁNTICA del conflicto de cierre.
 *
 * El primer corte disparaba el conflicto con `result.existingResultCode !== resultCode`
 * — comparación cruda, byte a byte, sobre cualquier par de valores. Tres problemas
 * reales, no teóricos:
 *
 * (a) El PERDEDOR sin resultCode (`null`) NO aporta ningún resultado. Es el caso
 *     normalísimo de "el staff cerró a mano desde el panel": SetTaskGeneralStatus y
 *     UpdateTask SIEMPRE pasan `resultCode: null`. Con la regla vieja, cada cierre
 *     manual sobre una tarea que IClass ya había cerrado generaba un `closure_conflict`
 *     con `loserResultCode: null` — ruido puro que entierra los conflictos de verdad.
 * (b) IClass devuelve el MISMO código con variaciones cosméticas ("Instalacion Completa
 *     Fibra" / "instalacion completa fibra." / doble espacio). Ya existe
 *     `normalizeResultCode` justo para eso, y el resolver del ingest LO USA. Comparar
 *     acá byte a byte contradice al resolver: mismo código → falso conflicto.
 * (c) Si la tarea NO EXISTE (`task: null`), no hay ganador, no hay perdedor y no hay
 *     nada que auditar: `existingResultCode` es null por "no hay fila", no por "el
 *     ganador no dejó resultado". Loguear ahí es inventar un conflicto.
 *
 * Lo que SIGUE siendo conflicto: perdedor con código y ganador SIN código (alguien
 * cerró sin resultado y ahora llega uno) — valores que difieren de verdad.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { applyTaskClosure } from '@application/use-cases/applyTaskClosure';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const CREATE_INPUT = {
  title: 'Tarea de prueba',
  description: null,
  stageId: '10000000-0000-4000-a000-000000000001',
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

function harness() {
  const repo = new InMemorySchedulingRepository();
  const recorder = new FakeTaskActivityRecorder();
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  return { repo, recorder, logSpy };
}

const conflicts = (r: FakeTaskActivityRecorder) => r.calls.filter(c => c.type === 'closure_conflict');
const loggedConflict = (s: jest.SpyInstance) =>
  s.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes('[task-closure-conflict]'));

afterEach(() => jest.restoreAllMocks());

describe('FIX-4 (a) — el PERDEDOR sin resultCode no es un conflicto', () => {
  it('staff cierra a mano (resultCode null) una tarea que iclass ya cerró → sin log, sin activity', async () => {
    const { repo, recorder, logSpy } = harness();
    const task = await repo.createTask(CREATE_INPUT);
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'INSTALACION_OK' });
    recorder.calls.length = 0;
    logSpy.mockClear();

    const result = await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'staff', resultCode: null });

    expect(result.closed).toBe(false);
    expect(conflicts(recorder)).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });

  it('resultCode OMITIDO (undefined) se comporta igual que null', async () => {
    const { repo, recorder, logSpy } = harness();
    const task = await repo.createTask(CREATE_INPUT);
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'INSTALACION_OK' });
    recorder.calls.length = 0;
    logSpy.mockClear();

    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'staff' });

    expect(conflicts(recorder)).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });

  it('CONTRASTE: el perdedor CON código sobre un ganador SIN código SÍ es conflicto', async () => {
    const { repo, recorder, logSpy } = harness();
    const task = await repo.createTask(CREATE_INPUT);
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'staff', resultCode: null });
    recorder.calls.length = 0;
    logSpy.mockClear();

    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'REAGENDADO' });

    expect(conflicts(recorder)).toHaveLength(1);
    expect(conflicts(recorder)[0]!.payload.metadata).toEqual({
      winnerOrigin: 'staff',
      winnerResultCode: null,
      loserOrigin: 'iclass',
      loserResultCode: 'REAGENDADO',
    });
    expect(loggedConflict(logSpy)).toBe(true);
  });
});

describe('FIX-4 (b) — dos códigos no-null se comparan NORMALIZADOS', () => {
  it.each([
    ['case + punto final', 'Instalacion Completa Fibra', 'instalacion completa fibra.'],
    ['espacios extremos', 'REAGENDADO', '  REAGENDADO  '],
    ['espacios internos colapsados', 'Sin  Material', 'Sin Material'],
  ])('%s → mismo código, NO es conflicto', async (_label, winner, loser) => {
    const { repo, recorder, logSpy } = harness();
    const task = await repo.createTask(CREATE_INPUT);
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'app', resultCode: winner });
    recorder.calls.length = 0;
    logSpy.mockClear();

    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: loser });

    expect(conflicts(recorder)).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });

  it('CONTRASTE: códigos realmente distintos SIGUEN siendo conflicto (la normalización no fusiona todo)', async () => {
    const { repo, recorder, logSpy } = harness();
    const task = await repo.createTask(CREATE_INPUT);
    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'app', resultCode: 'Reparacion-A' });
    recorder.calls.length = 0;
    logSpy.mockClear();

    await applyTaskClosure(repo, recorder, { taskId: task.id, origin: 'iclass', resultCode: 'Reparacion-B' });

    expect(conflicts(recorder)).toHaveLength(1);
    // El metadata guarda los valores CRUDOS, no los normalizados: la auditoría tiene
    // que mostrar lo que cada origen realmente mandó.
    expect(conflicts(recorder)[0]!.payload.metadata).toMatchObject({
      winnerResultCode: 'Reparacion-A',
      loserResultCode: 'Reparacion-B',
    });
  });
});

describe('FIX-4 (c) — tarea inexistente: ni log ni activity', () => {
  it('closeTaskIfOpen sobre un id que no existe → closed=false, task=null, silencio total', async () => {
    const { repo, recorder, logSpy } = harness();

    const result = await applyTaskClosure(repo, recorder, {
      taskId: 'no-existe',
      origin: 'iclass',
      resultCode: 'REAGENDADO',
    });

    expect(result.closed).toBe(false);
    expect(result.task).toBeNull();
    // No hay ganador: `existingResultCode` es null por AUSENCIA DE FILA, no por
    // "el ganador cerró sin resultado". Reportarlo sería inventar un conflicto.
    expect(conflicts(recorder)).toHaveLength(0);
    expect(loggedConflict(logSpy)).toBe(false);
  });
});
