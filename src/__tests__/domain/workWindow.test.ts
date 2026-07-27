import {
  computeWorkWindow,
  executionDurationMinutes,
  type SoStatusEvent,
} from '@domain/services/workWindow';

/** Histórico REAL de la OS 4995 (recortado a los estados de ejecución). */
const OS_4995_EXECUTION: SoStatusEvent[] = [
  { at: new Date('2026-07-01T23:29:02Z'), status: 'DESLOCAMENTO' },
  { at: new Date('2026-07-01T23:29:13Z'), status: 'ANDAMENTO' },
  { at: new Date('2026-07-01T23:31:18Z'), status: 'FECHADA' },
  { at: new Date('2026-07-01T23:31:19Z'), status: 'APROVAÇÃO' },
  { at: new Date('2026-07-02T13:40:25Z'), status: 'ENCERRADO' },
];

describe('computeWorkWindow', () => {
  it('spans from the first execution state to the closing state', () => {
    const w = computeWorkWindow(OS_4995_EXECUTION, { marginMinutes: 0 });
    expect(w!.from.toISOString()).toBe('2026-07-01T23:29:02.000Z');
    expect(w!.to.toISOString()).toBe('2026-07-01T23:31:18.000Z');
  });

  it('applies a symmetric margin because breadcrumbs arrive every 5-10 min', () => {
    const w = computeWorkWindow(OS_4995_EXECUTION, { marginMinutes: 15 });
    expect(w!.from.toISOString()).toBe('2026-07-01T23:14:02.000Z');
    expect(w!.to.toISOString()).toBe('2026-07-01T23:46:18.000Z');
  });

  it('IGNORES the scheduled date — only execution states define the window', () => {
    // Estados de agenda/despacho de días PREVIOS no deben ensanchar la ventana.
    const withScheduling: SoStatusEvent[] = [
      { at: new Date('2026-06-22T14:20:32Z'), status: 'AGENDADA' },
      { at: new Date('2026-06-26T14:04:43Z'), status: 'DESPACHADA' },
      { at: new Date('2026-06-30T14:23:39Z'), status: 'EM ANALISE' },
      ...OS_4995_EXECUTION,
    ];
    const w = computeWorkWindow(withScheduling, { marginMinutes: 0 });
    expect(w!.from.toISOString()).toBe('2026-07-01T23:29:02.000Z');
    expect(w!.from.getTime()).toBeGreaterThan(new Date('2026-07-01T00:00:00Z').getTime());
  });

  it('returns null when the order was never executed', () => {
    const neverExecuted: SoStatusEvent[] = [
      { at: new Date('2026-07-01T13:37:25Z'), status: 'AGENDADA' },
      { at: new Date('2026-07-01T14:36:02Z'), status: 'DESPACHADA' },
      { at: new Date('2026-07-01T14:38:39Z'), status: 'EM ANALISE' },
    ];
    expect(computeWorkWindow(neverExecuted)).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(computeWorkWindow([])).toBeNull();
  });

  it('returns NO window for an execution that never reached a closing state', () => {
    // CORREGIDO por el review adversarial (hallazgo 1.1). La versión anterior de este
    // test afirmaba que la ventana llega "hasta el último estado de ejecución" — que es
    // justo cuando el técnico EMPIEZA. Eso auditaba el tramo de VIAJE y devolvía
    // FUERA_DE_SITIO por estar en la ruta. Sin evento de cierre la cota superior es
    // desconocida, y desconocida NO es "termina acá": es NO_CONCLUYENTE.
    const open: SoStatusEvent[] = [
      { at: new Date('2026-07-01T15:00:00Z'), status: 'DESLOCAMENTO' },
      { at: new Date('2026-07-01T15:20:00Z'), status: 'ANDAMENTO' },
    ];
    expect(computeWorkWindow(open, { marginMinutes: 0 })).toBeNull();
  });

  it('accepts ENCERRADO as a closing state', () => {
    const withEncerrado: SoStatusEvent[] = [
      { at: new Date('2026-07-01T15:00:00Z'), status: 'DESLOCAMENTO' },
      { at: new Date('2026-07-01T18:00:00Z'), status: 'ENCERRADO' },
    ];
    const w = computeWorkWindow(withEncerrado, { marginMinutes: 0 });
    expect(w!.to.toISOString()).toBe('2026-07-01T18:00:00.000Z');
  });

  it('is not fooled by unordered history entries', () => {
    // IClass devuelve el histórico DESORDENADO (verificado en la OS 4995).
    const shuffled = [...OS_4995_EXECUTION].reverse();
    const w = computeWorkWindow(shuffled, { marginMinutes: 0 });
    expect(w!.from.toISOString()).toBe('2026-07-01T23:29:02.000Z');
    expect(w!.to.toISOString()).toBe('2026-07-01T23:31:18.000Z');
  });

  it('matches status names case-insensitively and ignoring accents', () => {
    const variants: SoStatusEvent[] = [
      { at: new Date('2026-07-01T15:00:00Z'), status: 'deslocamento' },
      { at: new Date('2026-07-01T15:05:00Z'), status: 'Fechada' },
    ];
    const w = computeWorkWindow(variants, { marginMinutes: 0 });
    expect(w).not.toBeNull();
    expect(w!.to.toISOString()).toBe('2026-07-01T15:05:00.000Z');
  });
});

describe('executionDurationMinutes — the cheap pre-filter', () => {
  it('measures the OS 4995 closure at ~2.3 minutes', () => {
    // DESLOCAMENTO 23:29:02 → FECHADA 23:31:18 == 2 min 16 s. No existe viaje de 11 segundos.
    const d = executionDurationMinutes(OS_4995_EXECUTION);
    expect(d).toBeGreaterThan(2.2);
    expect(d).toBeLessThan(2.4);
  });

  it('returns null when there is no execution window to measure', () => {
    expect(executionDurationMinutes([])).toBeNull();
    expect(
      executionDurationMinutes([{ at: new Date('2026-07-01T13:00:00Z'), status: 'AGENDADA' }]),
    ).toBeNull();
  });

  it('measures a plausible visit as well', () => {
    const normal: SoStatusEvent[] = [
      { at: new Date('2026-07-01T15:00:00Z'), status: 'DESLOCAMENTO' },
      { at: new Date('2026-07-01T15:25:00Z'), status: 'ANDAMENTO' },
      { at: new Date('2026-07-01T16:10:00Z'), status: 'FECHADA' },
    ];
    expect(executionDurationMinutes(normal)).toBeCloseTo(70, 1);
  });
});
