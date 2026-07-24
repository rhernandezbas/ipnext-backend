/**
 * AlertEventBus — C1 (`noc-alert-realtime`). Real `EventEmitter` wrapper
 * implementing `AlertEventPublisher`. Unit-level: pub/sub/unsub, multi-subscriber
 * isolation — the SSE route (C6-C13) is tested separately over a real HTTP
 * connection, this file only covers the bus itself.
 */
import { AlertEventBus } from '@infrastructure/events/AlertEventBus';
import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertEvent } from '@domain/ports/AlertEventPublisher';

function makeAlert(overrides: Partial<NocAlert> = {}): NocAlert {
  return {
    id: 'alert-1',
    source: 'grafana',
    fingerprint: 'fp-1',
    alertname: 'BGP peer down',
    severity: 'critical',
    status: 'firing',
    entityType: 'bgp_peer',
    entityName: 'peer-rda2',
    entityRef: null,
    metricName: null,
    metricValue: null,
    metricUnit: null,
    threshold: null,
    message: 'BGP peer down',
    explanation: null,
    link: null,
    startsAt: '2026-07-24T10:00:00.000Z',
    firstSeen: '2026-07-24T10:00:00.000Z',
    lastSeen: '2026-07-24T10:00:00.000Z',
    endsAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    acknowledged: false,
    ackBy: null,
    ackAt: null,
    ackNote: null,
    escalationState: null,
    telegramChatId: null,
    telegramMessageId: null,
    ...overrides,
  };
}

describe('AlertEventBus', () => {
  it('publish llega a un subscriber suscripto', () => {
    const bus = new AlertEventBus();
    const received: NocAlertEvent[] = [];
    bus.subscribe((event) => received.push(event));

    const event: NocAlertEvent = { type: 'firing', alert: makeAlert() };
    bus.publish(event);

    expect(received).toEqual([event]);
  });

  it('unsubscribe deja de recibir eventos publicados después', () => {
    const bus = new AlertEventBus();
    const received: NocAlertEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish({ type: 'firing', alert: makeAlert() });
    unsubscribe();
    bus.publish({ type: 'acked', alert: makeAlert({ acknowledged: true }) });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('firing');
  });

  it('múltiples subscribers reciben el MISMO evento, cada uno independiente', () => {
    const bus = new AlertEventBus();
    const receivedA: NocAlertEvent[] = [];
    const receivedB: NocAlertEvent[] = [];
    const unsubA = bus.subscribe((event) => receivedA.push(event));
    bus.subscribe((event) => receivedB.push(event));

    bus.publish({ type: 'resolved', alert: makeAlert({ status: 'resolved' }) });
    unsubA();
    bus.publish({ type: 'acked', alert: makeAlert({ acknowledged: true }) });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(2);
  });

  it('publish sin ningún subscriber no explota', () => {
    const bus = new AlertEventBus();
    expect(() => bus.publish({ type: 'firing', alert: makeAlert() })).not.toThrow();
  });

  it('listenerCount refleja subscribe/unsubscribe (seam de test para la ruta SSE)', () => {
    const bus = new AlertEventBus();
    expect(bus.listenerCount()).toBe(0);

    const unsubscribe = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(1);

    unsubscribe();
    expect(bus.listenerCount()).toBe(0);
  });
});
