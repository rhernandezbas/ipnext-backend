/**
 * K3 fix wave M5 — auditoría del onuSerial en el activity feed.
 *
 * onuSerial es EL campo que arma un cron que toca hardware: sin evento en el
 * feed no hay forensia de quién cargó/cambió/limpió el serial que disparó (o
 * bloqueó) un auto-aprovisionamiento.
 */
import { computeUpdateTaskActivities } from '@application/use-cases/computeUpdateTaskActivities';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import type { ScheduledTask } from '@domain/entities/scheduling';
import type { UpdateTaskInput } from '@domain/ports/SchedulingRepository';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

function prevWith(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return new InMemorySchedulingRepository().seedTask({ id: 'task-1', ...over });
}

function diff(prev: ScheduledTask, data: UpdateTaskInput) {
  return computeUpdateTaskActivities(prev, data, ACTOR);
}

describe('computeUpdateTaskActivities — onu_serial_changed (M5)', () => {
  it('SET: null → serial emite el evento con los valores', () => {
    const ev = diff(prevWith({ onuSerial: null }), { onuSerial: 'HWTC11112222' });
    expect(ev).toEqual([
      { type: 'onu_serial_changed', actor: ACTOR, fromValue: null, toValue: 'HWTC11112222' },
    ]);
  });

  it('CAMBIO: serial → otro serial emite from/to', () => {
    const ev = diff(prevWith({ onuSerial: 'HWTC11112222' }), { onuSerial: 'HWTC99998888' });
    expect(ev).toEqual([
      { type: 'onu_serial_changed', actor: ACTOR, fromValue: 'HWTC11112222', toValue: 'HWTC99998888' },
    ]);
  });

  it('LIMPIEZA: serial → null emite el evento (quién desarmó el gatillo)', () => {
    const ev = diff(prevWith({ onuSerial: 'HWTC11112222' }), { onuSerial: null });
    expect(ev).toEqual([
      { type: 'onu_serial_changed', actor: ACTOR, fromValue: 'HWTC11112222', toValue: null },
    ]);
  });

  it('mismo valor → nada; ausente del partial → nada', () => {
    expect(diff(prevWith({ onuSerial: 'HWTC11112222' }), { onuSerial: 'HWTC11112222' })).toEqual([]);
    expect(diff(prevWith({ onuSerial: 'HWTC11112222' }), { title: 'otro' })).not.toContainEqual(
      expect.objectContaining({ type: 'onu_serial_changed' }),
    );
  });
});
