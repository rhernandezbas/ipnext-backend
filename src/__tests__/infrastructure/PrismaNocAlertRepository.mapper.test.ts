import { toNocAlert } from '@infrastructure/adapters/prisma/PrismaNocAlertRepository';

describe('toNocAlert (Prisma row → domain entity mapper)', () => {
  it('mapea una row Prisma completa a NocAlert, Date → ISO string', () => {
    const row = {
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
      startsAt: new Date('2026-07-24T10:00:00.000Z'),
      firstSeen: new Date('2026-07-24T10:00:00.000Z'),
      lastSeen: new Date('2026-07-24T10:00:00.000Z'),
      endsAt: null,
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
      updatedAt: new Date('2026-07-24T10:00:00.000Z'),
      acknowledged: false,
      ackBy: null,
      ackAt: null,
      ackNote: null,
      escalationState: null,
      telegramChatId: null,
      telegramMessageId: null,
    };

    const alert = toNocAlert(row);

    expect(alert.id).toBe('alert-1');
    expect(alert.startsAt).toBe('2026-07-24T10:00:00.000Z');
    expect(alert.endsAt).toBeNull();
    expect(alert.status).toBe('firing');
    // Never a raw Date instance leaking through — always the ISO string.
    expect(typeof alert.startsAt).toBe('string');
  });

  it('mapea endsAt/ackAt no-nulos (Date → ISO string)', () => {
    const row = {
      id: 'alert-2',
      source: 'grafana',
      fingerprint: 'fp-2',
      alertname: 'x',
      severity: 'warning',
      status: 'resolved',
      entityType: 'router',
      entityName: 'RDA2',
      entityRef: null,
      metricName: null,
      metricValue: null,
      metricUnit: null,
      threshold: null,
      message: 'x',
      explanation: null,
      link: null,
      startsAt: new Date('2026-07-24T10:00:00.000Z'),
      firstSeen: new Date('2026-07-24T10:00:00.000Z'),
      lastSeen: new Date('2026-07-24T10:00:00.000Z'),
      endsAt: new Date('2026-07-24T11:00:00.000Z'),
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
      updatedAt: new Date('2026-07-24T11:00:00.000Z'),
      acknowledged: true,
      ackBy: 'juan',
      ackAt: new Date('2026-07-24T10:30:00.000Z'),
      ackNote: null,
      escalationState: null,
      telegramChatId: null,
      telegramMessageId: null,
    };

    const alert = toNocAlert(row);

    expect(alert.endsAt).toBe('2026-07-24T11:00:00.000Z');
    expect(alert.ackAt).toBe('2026-07-24T10:30:00.000Z');
    expect(alert.ackBy).toBe('juan');
  });
});
