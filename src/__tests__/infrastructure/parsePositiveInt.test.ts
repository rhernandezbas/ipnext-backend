/**
 * parsePositiveInt — contrato de las envs de CONTEO del watcher auto-move (pppoe-move-nas
 * D-W2.5 item 1): AUTO_MOVE_ABORT_THRESHOLD (default 25) y AUTO_MOVE_MAX_MOVES_PER_TICK
 * (default 10). Parse seguro: inválida/vacía/0/negativa → default, JAMÁS lanza — el boot
 * nunca falla por una env rota (mismo contrato que parseIntervalMs, pero para enteros que
 * no son intervalos).
 */
import { parsePositiveInt } from '@infrastructure/parsePositiveInt';

describe('parsePositiveInt — envs del breaker/cap (D-W2.5, S7.2-style)', () => {
  it('inválida / ausente / vacía → default (boot OK)', () => {
    expect(parsePositiveInt('garbage', { default: 25 })).toBe(25);
    expect(parsePositiveInt(undefined, { default: 25 })).toBe(25);
    expect(parsePositiveInt('', { default: 10 })).toBe(10);
  });

  it('0 / negativa → default (un fat-finger no puede dejar el breaker en 0 = abortar siempre)', () => {
    expect(parsePositiveInt('0', { default: 10 })).toBe(10);
    expect(parsePositiveInt('-5', { default: 25 })).toBe(25);
  });

  it('valor válido → se usa (truncado a entero)', () => {
    expect(parsePositiveInt('40', { default: 25 })).toBe(40);
    expect(parsePositiveInt('7.9', { default: 10 })).toBe(7);
  });

  it('clamp al techo (un valor absurdo no desactiva el breaker en la práctica)', () => {
    expect(parsePositiveInt('999999999999999999999', { default: 25, max: 100_000 })).toBe(100_000);
  });
});
