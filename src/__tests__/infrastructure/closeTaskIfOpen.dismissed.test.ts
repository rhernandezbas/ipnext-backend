/**
 * fix wave W1a / FIX-8 — PIN del comportamiento con tareas `dismissed`.
 *
 * Este test NO cambia nada: FIJA lo que el código ya hace, para que sea una DECISIÓN
 * VISIBLE y no un accidente del predicado.
 *
 * El guard atómico es `WHERE generalStatus != 'closed'`. Ese predicado matchea también
 * `'dismissed'`, así que `closeTaskIfOpen` sobre una tarea descartada la CIERRA. Se
 * evaluó cambiarlo a `WHERE generalStatus = 'open'` y se DESCARTÓ, por dos razones:
 *
 *  1. Los cuatro escritores actuales ya protegen a las dismissed por su cuenta y ANTES
 *     de llegar acá: IngestClosedServiceOrders bailea en los guards G1/G2 (#41),
 *     CloseIClassServiceOrder exige `generalStatus === 'open'` en su step 4, y los dos
 *     caminos de staff (SetTaskGeneralStatus / UpdateTask) son la operadora pidiendo
 *     explícitamente el cierre. Restringir el predicado no arregla ningún bug real.
 *  2. Cerrar una dismissed a mano es una operación LEGÍTIMA: la operadora descartó la
 *     tarea, cambió de opinión y la quiere cerrar formalmente. Un `WHERE = 'open'`
 *     convertiría eso en un fallo silencioso (`closed:false`, sin conflicto, sin error)
 *     — el peor de los mundos.
 *
 * La contrapartida está documentada en el port y en design.md: `CloseTaskFromField`
 * (wave 1b) DEBE chequear `dismissed` ANTES de invocar el guard, o su 409
 * `TASK_ALREADY_CLOSED` nunca dispara y la app cerraría tareas descartadas.
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

describe('FIX-8 — closeTaskIfOpen y las tareas dismissed (comportamiento PINEADO)', () => {
  it('una tarea dismissed SÍ es cerrada por closeTaskIfOpen (el predicado es != closed, no = open)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'dismissed', isClosed: false });

    const result = await repo.closeTaskIfOpen('t1', { origin: 'staff', resultCode: null, closedByUserId: 'u-1' });

    expect(result.closed).toBe(true);
    expect(result.task!.generalStatus).toBe('closed');
    expect(result.task!.closureOrigin).toBe('staff');
  });

  it('una tarea YA cerrada no se re-cierra (el fence sigue siendo el fence)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 't1', generalStatus: 'closed', isClosed: true, closureOrigin: 'iclass' });

    const result = await repo.closeTaskIfOpen('t1', { origin: 'staff', resultCode: null });

    expect(result.closed).toBe(false);
    expect(result.task!.closureOrigin).toBe('iclass');
  });

  it('el WHERE del adapter Prisma es exactamente `generalStatus != closed` (el pin es de los DOS adapters)', () => {
    // Pin textual sobre el adapter real: si alguien lo cambia a `= open` o a un `in`,
    // este test cae y obliga a re-discutir la decisión de arriba en vez de aplicarla en
    // silencio en un solo adapter (los dos tienen que moverse juntos).
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'infrastructure', 'adapters', 'prisma', 'PrismaSchedulingRepository.ts'),
      'utf8',
    ) as string;
    expect(src).toMatch(/where:\s*\{\s*id,\s*generalStatus:\s*\{\s*not:\s*'closed'\s*\}\s*\}/);
  });
});
