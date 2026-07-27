import { computeExecutionCycles, type SoStatusEvent } from '@domain/services/workWindow';

/**
 * Hallazgos 1.1 / 1.2 / 1.3 del review adversarial.
 *
 * La ventana de trabajo NO puede salir de `[primer evento de ejecución, primer cierre
 * posterior]`: eso audita el ciclo equivocado cuando la orden se reejecuta, y abarca
 * DÍAS cuando la orden rebota entre cuadrillas (la OS 4995 rebotó 9 días).
 *
 * Un ciclo = desde un estado de ejecución hasta su cierre. Cada ciclo lleva SU cuadrilla,
 * porque la orden puede reasignarse entre ciclos y auditar a la persona equivocada con
 * evidencia que se ve impecable es el peor resultado posible.
 */

const ev = (iso: string, status: string, teamLogin: string | null = 'IPNXANDYM'): SoStatusEvent => ({
  at: new Date(iso),
  status,
  teamLogin,
});

describe('computeExecutionCycles', () => {
  it('returns no cycles when the order was never executed', () => {
    expect(
      computeExecutionCycles([
        ev('2026-07-01T13:00:00Z', 'AGENDADA', null),
        ev('2026-07-01T14:00:00Z', 'DESPACHADA'),
        ev('2026-07-01T14:02:00Z', 'EM ANALISE'),
      ]),
    ).toEqual([]);
  });

  it('returns a single closed cycle for a plain execution', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T23:29:02Z', 'DESLOCAMENTO'),
      ev('2026-07-01T23:29:13Z', 'ANDAMENTO'),
      ev('2026-07-01T23:31:18Z', 'FECHADA'),
    ]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].from.toISOString()).toBe('2026-07-01T23:29:02.000Z');
    expect(cycles[0].to!.toISOString()).toBe('2026-07-01T23:31:18.000Z');
    expect(cycles[0].closed).toBe(true);
    expect(cycles[0].teamLogin).toBe('IPNXANDYM');
  });

  it('accepts ENCERRADO as a closing state (it exists in the real history)', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'DESLOCAMENTO'),
      ev('2026-07-01T14:05:00Z', 'ANDAMENTO'),
      ev('2026-07-01T18:00:00Z', 'ENCERRADO'),
    ]);
    expect(cycles[0].closed).toBe(true);
    expect(cycles[0].to!.toISOString()).toBe('2026-07-01T18:00:00.000Z');
  });

  it('marks a cycle without any closing event as NOT closed', () => {
    // Antes esto truncaba la ventana al último evento de ejecución —o sea, al momento
    // en que el técnico ARRANCA— y condenaba por lo que pasó en el viaje.
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'DESLOCAMENTO'),
      ev('2026-07-01T14:05:00Z', 'ANDAMENTO'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].closed).toBe(false);
    expect(cycles[0].to).toBeNull();
  });

  it('splits a re-execution into TWO cycles', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'DESLOCAMENTO'),
      ev('2026-07-01T14:20:00Z', 'FECHADA'),
      ev('2026-07-02T10:00:00Z', 'EM ANALISE', null),
      ev('2026-07-05T15:00:00Z', 'DESLOCAMENTO'),
      ev('2026-07-05T16:30:00Z', 'ANDAMENTO'),
      ev('2026-07-05T17:00:00Z', 'FECHADA'),
    ]);

    expect(cycles).toHaveLength(2);
    expect(cycles[0].from.toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(cycles[1].from.toISOString()).toBe('2026-07-05T15:00:00.000Z');
    expect(cycles[1].to!.toISOString()).toBe('2026-07-05T17:00:00.000Z');
  });

  it('never produces a cycle spanning days because of a bounced order', () => {
    // La 4995 rebotó del 22-06 al 02-07 entre dos cuadrillas.
    const cycles = computeExecutionCycles([
      ev('2026-06-22T14:20:32Z', 'DESLOCAMENTO', 'IPNXFERNANDOR'),
      ev('2026-06-26T14:04:43Z', 'EM ANALISE', 'IPNXANDYM', ),
      ev('2026-07-01T23:29:02Z', 'DESLOCAMENTO', 'IPNXANDYM'),
      ev('2026-07-01T23:29:13Z', 'ANDAMENTO', 'IPNXANDYM'),
      ev('2026-07-01T23:31:18Z', 'FECHADA', 'IPNXANDYM'),
    ]);

    // El DESLOCAMENTO suelto del 22-06 abre su propio ciclo SIN cierre; NO se fusiona
    // con la ejecución real del 01-07 formando una ventana de 9 días.
    const spans = cycles.map((c) => (c.to ? c.to.getTime() - c.from.getTime() : 0));
    for (const span of spans) {
      expect(span).toBeLessThan(24 * 60 * 60 * 1000);
    }
  });

  it('R6 — a re-dispatch to the SAME team does NOT split a legitimate cycle', () => {
    // Probado por la re-review: partir siempre recortaba la ventana dejando afuera el
    // viaje y la llegada — el tramo que justamente probaría EN_SITIO.
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'DESPACHADA'),
      ev('2026-07-01T14:10:00Z', 'DESLOCAMENTO'),
      ev('2026-07-01T14:40:00Z', 'DESPACHADA'),
      ev('2026-07-01T14:45:00Z', 'ANDAMENTO'),
      ev('2026-07-01T16:00:00Z', 'FECHADA'),
    ]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].from.toISOString()).toBe('2026-07-01T14:10:00.000Z');
    expect(cycles[0].to!.toISOString()).toBe('2026-07-01T16:00:00.000Z');
  });

  it('R6 — a re-dispatch to ANOTHER team DOES split the cycle', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:10:00Z', 'DESLOCAMENTO', 'IPNXANDYM'),
      ev('2026-07-01T14:40:00Z', 'DESPACHADA', 'IPNXEMAV'),
      ev('2026-07-01T14:45:00Z', 'ANDAMENTO', 'IPNXEMAV'),
      ev('2026-07-01T16:00:00Z', 'FECHADA', 'IPNXEMAV'),
    ]);

    expect(cycles).toHaveLength(2);
    expect(cycles[0].closed).toBe(false);
    expect(cycles[1].teamLogin).toBe('IPNXEMAV');
  });

  it('carries the team of EACH cycle, not the current assignee', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'DESLOCAMENTO', 'IPNXANDYM'),
      ev('2026-07-01T14:20:00Z', 'FECHADA', 'IPNXANDYM'),
      ev('2026-07-05T15:00:00Z', 'DESLOCAMENTO', 'IPNXEMAV'),
      ev('2026-07-05T17:00:00Z', 'FECHADA', 'IPNXEMAV'),
    ]);

    expect(cycles[0].teamLogin).toBe('IPNXANDYM');
    expect(cycles[1].teamLogin).toBe('IPNXEMAV');
  });

  it('sorts an unordered history before grouping', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T23:31:18Z', 'FECHADA'),
      ev('2026-07-01T23:29:02Z', 'DESLOCAMENTO'),
      ev('2026-07-01T23:29:13Z', 'ANDAMENTO'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].from.toISOString()).toBe('2026-07-01T23:29:02.000Z');
  });

  it('matches accented status names (APROVAÇÃO must not break the grouping)', () => {
    const cycles = computeExecutionCycles([
      ev('2026-07-01T14:00:00Z', 'deslocamento'),
      ev('2026-07-01T14:20:00Z', 'Fechada'),
      ev('2026-07-01T14:21:00Z', 'APROVAÇÃO'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].closed).toBe(true);
  });
});
