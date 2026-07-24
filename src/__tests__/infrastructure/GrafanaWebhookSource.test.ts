/**
 * GrafanaWebhookSource — mapper puro (payload de Grafana Alerting → NocAlertInput
 * canónico). B1 (label/annotation mapping) + B3 (elemento malformado → SKIP +
 * reporte, sobre malformado → error) + B4 (grouped webhook → N inputs
 * distintos). Fixtures = shape real de Grafana Alerting webhook (`{status,
 * alerts: [{status, labels, annotations, startsAt, endsAt, fingerprint,
 * generatorURL}]}`).
 *
 * OJO (hallazgo del review de A, F1): el validador de fechas de alerts.routes.ts
 * rechaza `endsAt: null` explícito → 400. En firing el mapper NO debe emitir la
 * clave `endsAt` (ni siquiera `undefined` con la clave presente) — se omite del
 * todo. Grafana además tiene un quirk conocido: en alertas `firing` a veces manda
 * `endsAt` con el zero-time de Go (`0001-01-01T00:00:00Z`) — eso también se trata
 * como "no seteado" y se omite.
 *
 * FIX WAVE (review adversarial de B) — decisión revisada: `mapWebhook` YA NO
 * rechaza atómicamente todo el webhook por UN elemento malo (F-B3); solo el
 * SOBRE (sin array `alerts`) sigue devolviendo el string de error. Fingerprint
 * ya no es requerido, se deriva si falta (F-B4). Severidad ampliada al
 * vocabulario real del .37 + normalización espacio/guión/underscore-insensitive
 * (F-B1).
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

  // F-B1 (fix wave) — actualizado a un alertname REAL de la familia
  // "rectificador" crítica del .37 (antes usaba "RectificadorFallaCritica",
  // sintético — un "rectificador" genérico ya no dispara critical porque
  // colisionaría con "Carga rectificador > 80%", que es warning).
  it('infiere severity=critical del alertname cuando no hay labels.severity (rectificador offline)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'Rectificador offline', router: 'r1' } }));

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
  it('sin status (o status inválido) → lanza error descriptivo', () => {
    const source = new GrafanaWebhookSource();

    expect(() => source.map(firingAlert({ status: 'bogus' }))).toThrow(/status/i);
  });

  it('sin labels.alertname (y sin commonLabels.alertname) → lanza error descriptivo', () => {
    const source = new GrafanaWebhookSource();
    const alert = firingAlert();
    delete (alert.labels as Record<string, unknown>)['alertname'];

    expect(() => source.map(alert)).toThrow(/alertname/i);
  });
});

// F-B4 (fix wave, MEDIUM) — el Grafana legacy del .37 puede no mandar
// `fingerprint`. En vez de tirar toda la ingesta, se deriva uno estable de
// alertname + labels. RED: hoy `map()` lanza "missing fingerprint" — con el
// fix debe devolver un input válido con fingerprint derivado y determinístico.
describe('GrafanaWebhookSource.map — F-B4 fingerprint con fallback', () => {
  it('sin fingerprint → NO lanza, deriva uno estable (no vacío, string)', () => {
    const source = new GrafanaWebhookSource();
    const alert = firingAlert();
    delete (alert as Record<string, unknown>)['fingerprint'];

    const input = source.map(alert);

    expect(typeof input.fingerprint).toBe('string');
    expect(input.fingerprint.length).toBeGreaterThan(0);
  });

  it('mismo alertname+labels sin fingerprint → siempre el MISMO fingerprint derivado (determinístico)', () => {
    const source = new GrafanaWebhookSource();
    const alert1 = firingAlert({ labels: { alertname: 'RectificadorFallaCritica', router: 'r1' } });
    const alert2 = firingAlert({ labels: { alertname: 'RectificadorFallaCritica', router: 'r1' } });
    delete (alert1 as Record<string, unknown>)['fingerprint'];
    delete (alert2 as Record<string, unknown>)['fingerprint'];

    const input1 = source.map(alert1);
    const input2 = source.map(alert2);

    expect(input1.fingerprint).toBe(input2.fingerprint);
  });

  it('distinto alertname/labels sin fingerprint → fingerprints derivados DISTINTOS', () => {
    const source = new GrafanaWebhookSource();
    const alertA = firingAlert({ labels: { alertname: 'HighCpu', router: 'r1' } });
    const alertB = firingAlert({ labels: { alertname: 'HighMemory', router: 'r2' } });
    delete (alertA as Record<string, unknown>)['fingerprint'];
    delete (alertB as Record<string, unknown>)['fingerprint'];

    const inputA = source.map(alertA);
    const inputB = source.map(alertB);

    expect(inputA.fingerprint).not.toBe(inputB.fingerprint);
  });

  it('con fingerprint explícito → se usa ESE, no se deriva nada', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ fingerprint: 'grafana-real-fp' }));

    expect(input.fingerprint).toBe('grafana-real-fp');
  });
});

// F-B1 (fix wave, HIGH — under-paging). Vocabulario real de alertnames del
// .37 (36 reglas) — hoy `inferSeverity` solo colapsa acentos y asume
// pegado/con-guión, así que "Router Caído" (con espacio) cae en warning. RED:
// estos alertnames REALES deben inferir 'critical' y hoy (antes del fix)
// caen en 'warning'.
describe('GrafanaWebhookSource.map — F-B1 severidad robusta (alertnames reales del .37)', () => {
  const CRITICAL_ALERTNAMES = [
    'Rectificador offline',
    'Rectificador sin AC',
    'Alarma crítica rectificador',
    'Router Caído',
    'Router offline',
    'Router SIN MÉTRICAS',
    '🔇 Telemetría CIEGA',
    '🧨 Carpet-bombing /24',
    '🦠 Cliente CGNAT comprometido',
    'BGP session caída',
    'BGP peer caído NE20 Chivilcoy',
    'BgpPeerDown',
    'Bus DC alto 48V',
    'Bus DC bajo 24V',
    'Monitor de energía offline',
    'ALGCom en batería',
  ];

  it.each(CRITICAL_ALERTNAMES)('"%s" → severity: critical', (alertname) => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname, router: 'r1' } }));

    expect(input.severity).toBe('critical');
  });

  const WARNING_ALERTNAMES = [
    'CPU > 80%',
    'Memoria alta',
    'Errores RX',
    'Drops RX',
    'Temperatura CPU',
    'Carga rectificador > 80%',
    '📈 Saturación física > 80%',
    'Interfaz DOWN',
    'Puerto DOWN',
    'Link down',
    'Batería descargándose',
  ];

  it.each(WARNING_ALERTNAMES)('"%s" → severity: warning (NO critical — no sobre-paginar)', (alertname) => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname, router: 'r1' } }));

    expect(input.severity).toBe('warning');
  });

  // Ambigüedad explícita de la task: "Batería descargándose" (warning) vs
  // "ALGCom en batería"/"Bus DC bajo" (critical) — el keyword "bateria" NO
  // debe pisar los específicos.
  it('"Batería descargándose" es warning aunque contenga "batería" (no confundir con ALGCom/Bus DC)', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'Batería descargándose', router: 'r1' } }));

    expect(input.severity).toBe('warning');
  });

  it('labels.severity="critical" GANA sobre un alertname que inferiría warning', () => {
    const source = new GrafanaWebhookSource();

    const input = source.map(
      firingAlert({ labels: { alertname: 'CPU > 80%', router: 'r1', severity: 'critical' } }),
    );

    expect(input.severity).toBe('critical');
  });

  it.each([
    ['crit', 'critical'],
    ['error', 'critical'],
    ['page', 'critical'],
    ['p1', 'critical'],
    ['p2', 'critical'],
    ['warn', 'warning'],
    ['p3', 'warning'],
    ['info', 'info'],
    ['none', 'info'],
  ] as const)('labels.severity=%s → %s (vocabulario Prometheus/Grafana mapeado)', (raw, expected) => {
    const source = new GrafanaWebhookSource();

    const input = source.map(firingAlert({ labels: { alertname: 'AlgunAlertname', router: 'r1', severity: raw } }));

    expect(input.severity).toBe(expected);
  });
});

describe('GrafanaWebhookSource.mapWebhook — B3/F-B3 payload malformado (sobre vs elemento)', () => {
  it('payload sin alerts → devuelve un string de error (rechazo del SOBRE, correcto)', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({ status: 'firing' });

    expect(typeof result).toBe('string');
  });

  it('payload con alerts vacío → devuelve un string de error', () => {
    const source = new GrafanaWebhookSource();

    const result = source.mapWebhook({ status: 'firing', alerts: [] });

    expect(typeof result).toBe('string');
  });

  // F-B3 (fix wave, MEDIUM) — RED: hoy un elemento malo tira TODO el webhook
  // (mapWebhook devuelve string). Con el fix, mapWebhook devuelve
  // `{mapped, skipped}` — el elemento sin `status` válido se SKIPPEA y se
  // reporta, el elemento bueno se mapea igual.
  it('elemento del array sin status válido → NO tira el string, se SKIPPEA y el elemento bueno se mapea', () => {
    const source = new GrafanaWebhookSource();
    const badAlert = { ...firingAlert(), status: 'bogus' };

    const result = source.mapWebhook({
      status: 'firing',
      alerts: [firingAlert({ fingerprint: 'good-1' }), badAlert],
    });

    expect(typeof result).toBe('object');
    const { mapped, skipped } = result as import('@infrastructure/adapters/grafana/GrafanaWebhookSource').GrafanaMapWebhookResult;
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.input.fingerprint).toBe('good-1');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.index).toBe(1);
    expect(skipped[0]?.reason).toMatch(/status/i);
  });

  it('5 elementos, alerts[3] malformado (sin alertname) → los 4 válidos se mapean, el [3] se reporta skipped', () => {
    const source = new GrafanaWebhookSource();
    const badAlert = firingAlert({ fingerprint: 'fp-bad' });
    delete (badAlert.labels as Record<string, unknown>)['alertname'];

    const result = source.mapWebhook({
      status: 'firing',
      alerts: [
        firingAlert({ fingerprint: 'fp-0' }),
        firingAlert({ fingerprint: 'fp-1' }),
        firingAlert({ fingerprint: 'fp-2' }),
        badAlert,
        firingAlert({ fingerprint: 'fp-4' }),
      ],
    });

    const { mapped, skipped } = result as import('@infrastructure/adapters/grafana/GrafanaWebhookSource').GrafanaMapWebhookResult;
    expect(mapped).toHaveLength(4);
    expect(mapped.map((m) => m.input.fingerprint)).toEqual(['fp-0', 'fp-1', 'fp-2', 'fp-4']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.index).toBe(3);
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

    expect(typeof result).toBe('object');
    const { mapped } = result as import('@infrastructure/adapters/grafana/GrafanaWebhookSource').GrafanaMapWebhookResult;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.input.fingerprint).toBe('fp-a');
    expect(mapped[1]?.input.fingerprint).toBe('fp-b');
    expect(mapped[0]?.input.entity.name).toBe('r1');
    expect(mapped[1]?.input.entity.name).toBe('r2');
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

    const { mapped } = result as import('@infrastructure/adapters/grafana/GrafanaWebhookSource').GrafanaMapWebhookResult;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.input.status).toBe('firing');
    expect('endsAt' in (mapped[0]?.input as object)).toBe(false);
    expect(mapped[1]?.input.status).toBe('resolved');
    expect(mapped[1]?.input.endsAt).toBe('2026-07-24T11:30:00.000Z');
  });
});
