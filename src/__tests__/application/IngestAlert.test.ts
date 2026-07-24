import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { InMemoryNocAlertRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
import { NoOpAlertNotifier } from '@infrastructure/adapters/in-memory/NoOpAlertNotifier';
import { AlertEventBus } from '@infrastructure/events/AlertEventBus';
import { NocAlertInput } from '@domain/entities/nocAlert';

function makeInput(overrides: Partial<NocAlertInput> = {}): NocAlertInput {
  return {
    source: 'fiber-collector',
    fingerprint: 'onu-abc-signal-critical',
    status: 'firing',
    alertname: 'ONU signal critical',
    severity: 'critical',
    entity: { type: 'onu', name: 'ONU-abc' },
    metric: { name: 'signal', value: -32, unit: 'dBm' },
    threshold: -30,
    message: 'Señal óptica crítica en ONU-abc',
    startsAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('IngestAlert', () => {
  it('crea un NocAlert firing cuando no existe ninguno con ese (source, fingerprint)', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);

    const alert = await useCase.execute(makeInput());

    expect(alert.status).toBe('firing');
    expect(alert.startsAt).toBe('2026-07-24T10:00:00.000Z');
    expect(alert.source).toBe('fiber-collector');
    expect(alert.fingerprint).toBe('onu-abc-signal-critical');

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
  });

  it('ingerir firing repetido para el mismo fingerprint NO duplica — actualiza la existente', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);

    const first = await useCase.execute(makeInput());
    const second = await useCase.execute(makeInput({ message: 'Señal óptica crítica en ONU-abc (re-evaluada)' }));

    expect(second.id).toBe(first.id);
    expect(second.message).toBe('Señal óptica crítica en ONU-abc (re-evaluada)');

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
  });

  it('resolved cierra la firing existente (mismo source+fingerprint)', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);

    const firing = await useCase.execute(makeInput());
    const resolved = await useCase.execute(
      makeInput({ status: 'resolved', endsAt: '2026-07-24T11:00:00.000Z' }),
    );

    expect(resolved.id).toBe(firing.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.endsAt).toBe('2026-07-24T11:00:00.000Z');

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
  });

  // A6 — decisión de design.md: resolved sin firing previo se CREA igual.
  it('resolved sin firing previo crea igual la fila (startsAt = endsAt) y loguea warning', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const alert = await useCase.execute(
      makeInput({ status: 'resolved', endsAt: '2026-07-24T12:00:00.000Z' }),
    );

    expect(alert.status).toBe('resolved');
    expect(alert.startsAt).toBe('2026-07-24T12:00:00.000Z');
    expect(alert.endsAt).toBe('2026-07-24T12:00:00.000Z');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('publica un evento firing/resolved por AlertEventPublisher DESPUÉS de persistir', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);

    const alert = await useCase.execute(makeInput());

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]).toEqual({ type: 'firing', alert });
  });

  // F6 (fix wave) — gap de cobertura señalado por revisión adversarial: la
  // transición MÁS riesgosa del ciclo de vida (re-fire tras resolved) tenía
  // código correcto (computeNocAlertIngest, rama `resurrecting`) pero CERO test
  // explícito ejercitándola end-to-end vía el use-case.
  it('re-fire tras resolved RESUCITA la fila: firing, startsAt nuevo, endsAt null, ACK reseteado', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const useCase = new IngestAlert(repo, publisher);

    const firing = await useCase.execute(makeInput());
    const resolved = await useCase.execute(
      makeInput({ status: 'resolved', endsAt: '2026-07-24T11:00:00.000Z' }),
    );
    await repo.acknowledge(resolved.id, 'juan.perez', '2026-07-24T11:05:00.000Z', 'cerrado');

    const resurrected = await useCase.execute(
      makeInput({ status: 'firing', startsAt: '2026-07-25T09:00:00.000Z' }),
    );

    expect(resurrected.id).toBe(firing.id);
    expect(resurrected.status).toBe('firing');
    expect(resurrected.startsAt).toBe('2026-07-25T09:00:00.000Z');
    expect(resurrected.endsAt).toBeNull();
    expect(resurrected.acknowledged).toBe(false);
    expect(resurrected.ackBy).toBeNull();
    expect(resurrected.ackAt).toBeNull();
    expect(resurrected.ackNote).toBeNull();

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);
  });

  // A9 — dark ingestion (spec.md "Dark ingestion — no outbound side-effects").
  it('dark ingestion: con publisher no-op, ingesta persiste y NO invoca ningún notifier', async () => {
    const repo = new InMemoryNocAlertRepository();
    const publisher = new NoOpAlertEventPublisher();
    const notifier = new NoOpAlertNotifier();
    const useCase = new IngestAlert(repo, publisher);

    const alert = await useCase.execute(makeInput());

    expect(alert.status).toBe('firing');
    const stored = await repo.findById(alert.id);
    expect(stored).not.toBeNull();

    // IngestAlert never receives/references an AlertNotifier (Fase D fan-out is
    // wired separately, off the event bus) — this notifier instance, kept alive
    // in this test's scope, must never be touched.
    expect(notifier.notifyCalls).toHaveLength(0);
    expect(notifier.editAckCalls).toHaveLength(0);
  });

  // F-C2 (fix wave, MEDIUM) — con el AlertEventBus REAL (no el NoOp, que nunca
  // tira), un subscriber SSE que lanza (ej. socket destruido a mitad de
  // res.write) no debe hacer que execute() propague la excepción: el persist
  // ya se completó OK, así que el caller (la ruta /ingest/:source) tiene que
  // ver un resultado normal, NUNCA un 500 espurio.
  it('con un subscriber que tira en el AlertEventBus real, execute() NO tira — el persist ya se completó', async () => {
    const repo = new InMemoryNocAlertRepository();
    const bus = new AlertEventBus();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.subscribe(() => {
      throw new Error('res.write sobre socket destruido');
    });
    const useCase = new IngestAlert(repo, bus);

    await expect(useCase.execute(makeInput())).resolves.toMatchObject({ status: 'firing' });

    const stored = await repo.list({});
    expect(stored).toHaveLength(1);

    errorSpy.mockRestore();
  });
});
