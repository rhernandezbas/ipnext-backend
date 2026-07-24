import { toNocAlertDto, computeMttaSeconds } from '@application/dto/nocAlert';
import { NocAlert } from '@domain/entities/nocAlert';

const baseAlert: NocAlert = {
  id: 'alert-1',
  source: 'grafana',
  fingerprint: 'internal-dedup-key-should-not-leak',
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
  telegramChatId: 'internal-telegram-chat-id',
  telegramMessageId: 'internal-telegram-message-id',
};

describe('computeMttaSeconds', () => {
  it('retorna null si no hay ackAt', () => {
    expect(computeMttaSeconds('2026-07-24T10:00:00.000Z', null)).toBeNull();
  });

  it('calcula ackAt - startsAt en segundos', () => {
    expect(computeMttaSeconds('2026-07-24T10:00:00.000Z', '2026-07-24T10:05:00.000Z')).toBe(300);
  });
});

describe('toNocAlertDto', () => {
  it('no expone fingerprint ni campos internos de Telegram (nunca entidad cruda)', () => {
    const dto = toNocAlertDto(baseAlert);

    expect(dto).not.toHaveProperty('fingerprint');
    expect(dto).not.toHaveProperty('telegramChatId');
    expect(dto).not.toHaveProperty('telegramMessageId');
  });

  it('expone el MTTA calculado cuando hay ackAt', () => {
    const acked: NocAlert = { ...baseAlert, acknowledged: true, ackBy: 'juan', ackAt: '2026-07-24T10:05:00.000Z' };
    const dto = toNocAlertDto(acked);

    expect(dto.mttaSeconds).toBe(300);
    expect(dto.ackBy).toBe('juan');
  });

  it('mttaSeconds es null sin ack', () => {
    const dto = toNocAlertDto(baseAlert);
    expect(dto.mttaSeconds).toBeNull();
  });

  it('conserva los campos de negocio (id, source, severity, status, entity, message)', () => {
    const dto = toNocAlertDto(baseAlert);
    expect(dto).toMatchObject({
      id: 'alert-1',
      source: 'grafana',
      alertname: 'BGP peer down',
      severity: 'critical',
      status: 'firing',
      entityType: 'bgp_peer',
      entityName: 'peer-rda2',
      message: 'BGP peer down',
    });
  });
});
