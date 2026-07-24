/**
 * GrafanaWebhookSource — mapper puro (payload de Grafana Alerting → NocAlertInput
 * canónico). B1 (label/annotation mapping) + B3 (malformed → error, sin side
 * effects) + B4 (grouped webhook → N inputs distintos). Fixtures = shape real
 * de Grafana Alerting webhook (`{status, alerts: [{status, labels, annotations,
 * startsAt, endsAt, fingerprint, generatorURL}]}`).
 *
 * OJO (hallazgo del review de A, F1): el validador de fechas de alerts.routes.ts
 * rechaza `endsAt: null` explícito → 400. En firing el mapper NO debe emitir la
 * clave `endsAt` (ni siquiera `undefined` con la clave presente) — se omite del
 * todo. Grafana además tiene un quirk conocido: en alertas `firing` a veces manda
 * `endsAt` con el zero-time de Go (`0001-01-01T00:00:00Z`) — eso también se trata
 * como "no seteado" y se omite.
 */
import { GrafanaWebhookSource } from '@infrastructure/adapters/grafana/GrafanaWebhookSource';

function firingAlert(overrides: Record<string, unknown> = {}) {
  return {
    status: 'firing',
    labels: { alertname: 'BgpPeerDown', router: 'core-1' },
    annotations: { description: 'BGP peer down', runbook_url: 'https://runbooks.ipnext/bgp-peer-down' },
    startsAt: '2026-07-24T10:00:00.000Z',
    endsAt: '0001-01-01T00:00:00Z', // Go zero-time — Grafana quirk, debe tratarse como "no seteado"
    fingerprint: 'abc123',
    generatorURL: 'https://grafana.ipnext/d/bgp/panel-1',
    ...overrides,
  };
}

function resolvedAlert(overrides: Record<string, unknown> = {}) {
  return {
    status: 'resolved',
    labels: { alertname: 'BgpPeerDown', router: 'core-1' },
    annotations: { description: 'BGP peer down' },
    startsAt: '2026-07-24T10:00:00.000Z',
    endsAt: '2026-07-24T10:15:00.000Z',
    fingerprint: 'abc123',
    generatorURL: 'https://grafana.ipnext/d/bgp/panel-1',
    ...overrides,
  };
}

describe('GrafanaWebhookSource.map — B1 label/annotation mapping', () => {
  it('mapea labels.alertname → alertname, labels.router → entityName, annotations → message/explanation, generatorURL → link, fingerprint → fingerprint', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert());

    expect(input.source).toBe('grafana');
    expect(input.alertname).toBe('BgpPeerDown');
    expect(input.entity.name).toBe('core-1');
    expect(input.message).toBe('BGP peer down');
    expect(input.explanation).toBe('https://runbooks.ipnext/bgp-peer-down');
    expect(input.link).toBe('https://grafana.ipnext/d/bgp/panel-1');
    expect(input.fingerprint).toBe('abc123');
    expect(input.status).toBe('firing');
  });

  // OJO — el bug de F1: firing NUNCA debe emitir la clave endsAt.
  it('firing NO incluye la clave endsAt (ni siquiera undefined) — incluye el caso del Go zero-time de Grafana', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert());

    expect('endsAt' in input).toBe(false);
  });

  it('firing sin el quirk del zero-time (endsAt ausente directamente) tampoco incluye endsAt', () => {
    const source = new GrafanaWebhookSource();
    const alert = firingAlert();
    delete (alert as Record<string, unknown>)['endsAt'];

    const input = source.map(alert);

    expect('endsAt' in input).toBe(false);
  });

  it('resolved SÍ incluye endsAt tomado de la fuente', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(resolvedAlert());

    expect(input.status).toBe('resolved');
    expect(input.endsAt).toBe('2026-07-24T10:15:00.000Z');
  });

  it('entity mapping: prioriza routerboard_name sobre router/nombre/equipo/instance/network', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(
      firingAlert({
        labels: {
          alertname: 'HighCpu',
          routerboard_name: 'RB-CORE-1',
          router: 'ignored-router',
          nombre: 'ignored-nombre',
          instance: 'ignored-instance',
          network: 'ignored-network',
        },
      }),
    );

    expect(input.entity.name).toBe('RB-CORE-1');
  });

  it('entity mapping: cae a instance cuando no hay routerboard_name/router/nombre/equipo', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(
      firingAlert({ labels: { alertname: 'HighMemory', instance: 'srv-monitor-1:9100' } }),
    );

    expect(input.entity.name).toBe('srv-monitor-1:9100');
    expect(input.entity.type).toBe('instance');
  });

  it('entity mapping: cae a network cuando solo hay labels.network', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'NetworkSaturation', network: 'RDA2' } }));

    expect(input.entity.name).toBe('RDA2');
    expect(input.entity.type).toBe('network');
  });

  it('message cae a annotations.summary si falta description', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(
      firingAlert({ annotations: { summary: 'Resumen corto' } }),
    );

    expect(input.message).toBe('Resumen corto');
  });

  it('usa labels.severity explícita cuando está presente (no infiere)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(
      firingAlert({ labels: { alertname: 'HighCpu', router: 'r1', severity: 'info' } }),
    );

    expect(input.severity).toBe('info');
  });

  it('infiere severity=critical del alertname cuando no hay labels.severity (rectificador)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'RectificadorFallaCritica', router: 'r1' } }));

    expect(input.severity).toBe('critical');
  });

  it('infiere severity=critical del alertname (router-caído)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'RouterCaidoAlert', router: 'r1' } }));

    expect(input.severity).toBe('critical');
  });

  it('infiere severity=warning del alertname cuando no hay labels.severity (cpu)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'HighCpuUsage', router: 'r1' } }));

    expect(input.severity).toBe('warning');
  });

  it('alertname cae a commonLabels.alertname (contexto del webhook) cuando falta en labels del elemento', () => {
    const source = new GrafanaWebhookSource();
    const alert = firingAlert();
    delete (alert.labels as Record<string, unknown>)['alertname'];

    const input = source.map(alert, { commonLabels: { alertname: 'GroupedAlertName' } });

    expect(input.alertname).toBe('GroupedAlertName');
  });
});

describe('GrafanaWebhookSource.map — malformado (elemento individual)', () => {
  it('sin fingerprint → lanza error descriptivo', () => {
    const source = new GrafanaWebhookSource();
    const alert = firingAlert();
    delete (alert as Record<string, unknown>)['fingerprint'];

    expect(() => source.map(alert)).toThrow(/fingerprint/i);
  });

  it('sin status (o status inválido) → lanza error descriptivo', () => {
    const source = new GrafanaWebhookSource();

    expect(() => source.map(firingAlert({ status: 'bogus' }))).toThrow(/status/i);
  });
});

describe('GrafanaWebhookSource.mapWebhook — B3 payload malformado (sin side effects, error puro)', () => {
  it('payload sin alerts → devuelve un string de error (no un array)', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({ status: 'firing' });

    expect(typeof result).toBe('string');
  });

  it('payload con alerts vacío → devuelve un string de error', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({ status: 'firing', alerts: [] });

    expect(typeof result).toBe('string');
  });

  it('elemento del array sin fingerprint → devuelve un string de error, NINGÚN elemento se mapea', () => {
    const source = new GrafanaWebhookSource();
    const badAlert = firingAlert();
    delete (badAlert as Record<string, unknown>)['fingerprint'];

    const result = source.mapWebhook({ status: 'firing', alerts: [firingAlert({ fingerprint: 'good-1' }), badAlert] });

    expect(typeof result).toBe('string');
  });

  it('elemento del array sin status → devuelve un string de error', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({
      status: 'firing',
      alerts: [{ ...firingAlert(), status: undefined }],
    });

    expect(typeof result).toBe('string');
  });
});

describe('GrafanaWebhookSource.mapWebhook — B4 webhook agrupado (N alertas → N inputs)', () => {
  it('2 elementos con fingerprint distintos → 2 NocAlertInput distintos, cada uno con su propio fingerprint/alertname', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({
      status: 'firing',
      alerts: [
        firingAlert({ fingerprint: 'fp-a', labels: { alertname: 'HighCpu', router: 'r1' } }),
        firingAlert({ fingerprint: 'fp-b', labels: { alertname: 'HighMemory', router: 'r2' } }),
      ],
    });

    expect(Array.isArray(result)).toBe(true);
    const inputs = result as import('@domain/entities/nocAlert').NocAlertInput[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.fingerprint).toBe('fp-a');
    expect(inputs[1]?.fingerprint).toBe('fp-b');
    expect(inputs[0]?.entity.name).toBe('r1');
    expect(inputs[1]?.entity.name).toBe('r2');
  });

  it('webhook mixto firing+resolved → cada input conserva su propio status/endsAt', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({
      status: 'mixed',
      alerts: [
        firingAlert({ fingerprint: 'fp-a' }),
        resolvedAlert({ fingerprint: 'fp-b', endsAt: '2026-07-24T11:30:00.000Z' }),
      ],
    });

    const inputs = result as import('@domain/entities/nocAlert').NocAlertInput[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.status).toBe('firing');
    expect('endsAt' in (inputs[0] as object)).toBe(false);
    expect(inputs[1]?.status).toBe('resolved');
    expect(inputs[1]?.endsAt).toBe('2026-07-24T11:30:00.000Z');
  });
});
