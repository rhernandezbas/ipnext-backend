/**
 * portal-usage-metrics — "Mi consumo" de Mis servicios (`GET /api/portal/usage/:contractId`).
 *
 * Los dos tests que importan de verdad son (a) y (b): son los que protegen al
 * NÚMERO que ve el cliente.
 *
 *  (a) `bytesOut` = DESCARGA, `bytesIn` = SUBIDA. Medido sobre la población real
 *      de `RadiusEvent` en prod: 41.572 sesiones con bytesOut>bytesIn contra 2.220
 *      al revés, y 1.671 TB out contra 169 TB in (10:1). Invertirlo le muestra al
 *      cliente que subió 10 veces lo que bajó.
 *  (b) los contadores son ACUMULADOS por sesión, NO deltas: cada evento trae el
 *      total de ESA sesión hasta ese momento. Sumar los eventos MULTIPLICA el
 *      consumo. El port deduplica por `sourceUniqueId` quedándose con el último.
 *
 * El resto cubre anti-IDOR (404 indistinguible), "sin PPPoE" como estado NORMAL,
 * el calendario completo del mes con ceros, y el pico.
 */
import { GetPortalUsageMetrics } from '@application/use-cases/portal/GetPortalUsageMetrics';
import { InMemoryUsageMetricsReader } from '@infrastructure/adapters/in-memory/InMemoryUsageMetricsReader';
import { UsageContractNotFoundError } from '@domain/errors/usage';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { Contract } from '@domain/entities/customer';
import type { PppoeService } from '@domain/entities/pppoeService';

/** 2026-08-05T14:00:00Z = 11:00 del 5 de agosto en Argentina (UTC-3, sin DST). */
const NOW = new Date('2026-08-05T14:00:00.000Z');

const GB = 1_000_000_000;

function makeContract(id: string): Contract {
  return {
    id,
    code: null,
    type: 'internet',
    plan: '100 Mb',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: null,
    lat: null,
    lng: null,
    technology: null,
    name: null,
    vendedor: null,
    services: [],
  } as Contract;
}

function fakeCustomers(byClient: Record<string, Contract[]>): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function makePppoe(overrides: Partial<PppoeService> & { username: string }): PppoeService {
  return {
    id: `pppoe-${overrides.username}`,
    password: 'secret',
    profile: 'IP-Air-100',
    remoteAddress: '100.64.28.10',
    status: 'enabled',
    nasId: 'nas-1',
    contractId: 'c1',
    enforcedState: 'active',
    callerId: null,
    ipMode: 'fixed',
    ipTypePreference: 'cgnat',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as PppoeService;
}

function fakePppoe(byContract: Record<string, PppoeService[]>): Pick<PppoeServiceRepository, 'findByContract'> {
  return { findByContract: async (contractId: string) => byContract[contractId] ?? [] };
}

function buildUseCase(opts?: {
  contracts?: Record<string, Contract[]>;
  pppoe?: Record<string, PppoeService[]>;
}) {
  const reader = new InMemoryUsageMetricsReader();
  const useCase = new GetPortalUsageMetrics(
    fakeCustomers(opts?.contracts ?? { 'client-a': [makeContract('c1')] }),
    fakePppoe(opts?.pppoe ?? { c1: [makePppoe({ username: 'juan.perez' })] }),
    reader,
    () => NOW,
  );
  return { useCase, reader };
}

describe('GetPortalUsageMetrics', () => {
  it('(a) la DESCARGA sale de bytesOut y la SUBIDA de bytesIn — invertirlos rompe este test', async () => {
    const { useCase, reader } = buildUseCase();
    // Una sola sesión, asimétrica a propósito: 700 GB abajo / 30 GB arriba.
    // Si el mapeo se invierte, el cliente ve que subió 700 GB.
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-02T15:00:00.000Z'),
      bytesIn: BigInt(30 * GB),
      bytesOut: BigInt(700 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.available).toBe(true);
    expect(res.downloadBytes).toBe(700 * GB);
    expect(res.uploadBytes).toBe(30 * GB);
    expect(res.totalBytes).toBe(730 * GB);
    expect(res.daily.find((d) => d.date === '2026-08-02')).toEqual({
      date: '2026-08-02',
      downloadBytes: 700 * GB,
      uploadBytes: 30 * GB,
    });
  });

  it('(b) DOS eventos de la MISMA sesión NO se suman: los contadores son ACUMULADOS, no deltas', async () => {
    const { useCase, reader } = buildUseCase();
    // Interim a mitad de sesión y luego el stop: el stop trae el TOTAL de la
    // sesión (100 GB), no los 40 GB que faltaban. Sumar los dos daría 160 GB.
    reader.record({
      sourceUniqueId: 'sesion-unica',
      username: 'juan.perez',
      startedAt: new Date('2026-08-03T10:00:00.000Z'),
      bytesIn: BigInt(6 * GB),
      bytesOut: BigInt(60 * GB),
    });
    reader.record({
      sourceUniqueId: 'sesion-unica',
      username: 'juan.perez',
      startedAt: new Date('2026-08-03T10:00:00.000Z'),
      bytesIn: BigInt(10 * GB),
      bytesOut: BigInt(100 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.downloadBytes).toBe(100 * GB); // NO 160
    expect(res.uploadBytes).toBe(10 * GB); // NO 16
    expect(res.totalBytes).toBe(110 * GB);
    expect(res.daily.find((d) => d.date === '2026-08-03')).toEqual({
      date: '2026-08-03',
      downloadBytes: 100 * GB,
      uploadBytes: 10 * GB,
    });
  });

  it('(b bis) DOS sesiones DISTINTAS sí se suman (el dedup no puede comerse tráfico real)', async () => {
    const { useCase, reader } = buildUseCase();
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-03T10:00:00.000Z'),
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(10 * GB),
    });
    reader.record({
      sourceUniqueId: 's2',
      username: 'juan.perez',
      startedAt: new Date('2026-08-03T20:00:00.000Z'),
      bytesIn: BigInt(2 * GB),
      bytesOut: BigInt(20 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.downloadBytes).toBe(30 * GB);
    expect(res.uploadBytes).toBe(3 * GB);
  });

  it('(c) anti-IDOR: contrato AJENO tira el MISMO error que un contrato inexistente', async () => {
    const { useCase } = buildUseCase({
      contracts: { 'client-a': [makeContract('c1')], 'client-b': [makeContract('c2')] },
    });

    // Ajeno: existe, pero es de client-b.
    await expect(useCase.execute('client-a', 'c2')).rejects.toBeInstanceOf(UsageContractNotFoundError);
    // Inexistente.
    await expect(useCase.execute('client-a', 'no-existe')).rejects.toBeInstanceOf(UsageContractNotFoundError);

    const ajeno = await useCase.execute('client-a', 'c2').catch((e: UsageContractNotFoundError) => e);
    const inexistente = await useCase.execute('client-a', 'no-existe').catch((e: UsageContractNotFoundError) => e);
    // Mismo code y mismo mensaje: la respuesta no puede filtrar cuál de los dos casos pasó.
    expect((ajeno as UsageContractNotFoundError).code).toBe((inexistente as UsageContractNotFoundError).code);
    expect((ajeno as UsageContractNotFoundError).message).toBe((inexistente as UsageContractNotFoundError).message);
  });

  it('(c bis) anti-IDOR: NUNCA consulta el consumo de un contrato que no es del cliente', async () => {
    const { useCase, reader } = buildUseCase({
      contracts: { 'client-a': [makeContract('c1')], 'client-b': [makeContract('c2')] },
      pppoe: { c2: [makePppoe({ username: 'ajeno', contractId: 'c2' })] },
    });
    reader.record({
      sourceUniqueId: 's1',
      username: 'ajeno',
      startedAt: new Date('2026-08-02T15:00:00.000Z'),
      bytesIn: 1n,
      bytesOut: 2n,
    });

    await expect(useCase.execute('client-a', 'c2')).rejects.toBeInstanceOf(UsageContractNotFoundError);
    expect(reader.queries).toHaveLength(0); // ni siquiera se preguntó
  });

  it('(d) contrato SIN PPPoE -> 200 con available:false (estado NORMAL, no un error)', async () => {
    const { useCase } = buildUseCase({ pppoe: {} });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.available).toBe(false);
    expect(res.downloadBytes).toBe(0);
    expect(res.uploadBytes).toBe(0);
    expect(res.totalBytes).toBe(0);
    expect(res.daily).toEqual([]);
    expect(res.peakDay).toBeNull();
    // El período viaja igual: la app dibuja el encabezado del mes aunque no haya datos.
    expect(res.period).toEqual({ from: '2026-08-01', to: '2026-08-05' });
  });

  it('(d bis) contrato CON PPPoE pero SIN sesiones en el mes -> available:false', async () => {
    const { useCase } = buildUseCase();

    const res = await useCase.execute('client-a', 'c1');

    expect(res.available).toBe(false);
    expect(res.totalBytes).toBe(0);
    expect(res.daily).toEqual([]);
  });

  it('(e) daily trae TODOS los días del mes hasta hoy, con ceros donde no hubo tráfico', async () => {
    const { useCase, reader } = buildUseCase();
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-04T12:00:00.000Z'),
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(5 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.daily.map((d) => d.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    expect(res.daily.filter((d) => d.downloadBytes === 0 && d.uploadBytes === 0)).toHaveLength(4);
    expect(res.period).toEqual({ from: '2026-08-01', to: '2026-08-05' });
  });

  it('(f) peakDay es el día de MAYOR total (descarga + subida), no el de mayor descarga', async () => {
    const { useCase, reader } = buildUseCase();
    // Día 1: 50 down + 5 up = 55. Día 2: 40 down + 30 up = 70 (gana por el total).
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-01T12:00:00.000Z'),
      bytesIn: BigInt(5 * GB),
      bytesOut: BigInt(50 * GB),
    });
    reader.record({
      sourceUniqueId: 's2',
      username: 'juan.perez',
      startedAt: new Date('2026-08-02T12:00:00.000Z'),
      bytesIn: BigInt(30 * GB),
      bytesOut: BigInt(40 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.peakDay).toEqual({ date: '2026-08-02', totalBytes: 70 * GB });
  });

  it('el rango consultado es el MES CALENDARIO en curso en hora de Argentina (arranca el 1 a las 00:00 ART = 03:00Z)', async () => {
    const { useCase, reader } = buildUseCase();

    await useCase.execute('client-a', 'c1');

    expect(reader.queries).toHaveLength(1);
    expect(reader.queries[0]).toEqual({
      username: 'juan.perez',
      from: new Date('2026-08-01T03:00:00.000Z'),
      to: NOW,
    });
  });

  it('una sesión del mes ANTERIOR no entra (el filtro de rango es del port, no del use case)', async () => {
    const { useCase, reader } = buildUseCase();
    reader.record({
      sourceUniqueId: 'vieja',
      username: 'juan.perez',
      startedAt: new Date('2026-07-31T20:00:00.000Z'), // 17:00 ART del 31/7
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(90 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.available).toBe(false);
    expect(res.totalBytes).toBe(0);
  });

  it('el consumo de OTRO username no se mezcla (el port filtra por username)', async () => {
    const { useCase, reader } = buildUseCase();
    reader.record({
      sourceUniqueId: 'otro',
      username: 'otro.cliente',
      startedAt: new Date('2026-08-02T12:00:00.000Z'),
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(999 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.available).toBe(false);
    expect(res.totalBytes).toBe(0);
  });

  it('una sesión de las 22:00 ART cuenta en SU día local, no en el día siguiente UTC', async () => {
    const { useCase, reader } = buildUseCase();
    // 2026-08-04T01:30Z = 22:30 del 3 de agosto en Argentina.
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-04T01:30:00.000Z'),
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(9 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(res.daily.find((d) => d.date === '2026-08-03')?.downloadBytes).toBe(9 * GB);
    expect(res.daily.find((d) => d.date === '2026-08-04')?.downloadBytes).toBe(0);
  });

  it('con VARIOS PPPoE en el contrato usa el CANÓNICO (pickCurrentPppoeService: enabled gana a terminated)', async () => {
    const { useCase, reader } = buildUseCase({
      pppoe: {
        c1: [
          makePppoe({ username: 'viejo', status: 'terminated', createdAt: '2026-01-01T00:00:00.000Z' }),
          makePppoe({ username: 'actual', status: 'enabled', createdAt: '2025-01-01T00:00:00.000Z' }),
        ],
      },
    });
    reader.record({
      sourceUniqueId: 's1',
      username: 'actual',
      startedAt: new Date('2026-08-02T12:00:00.000Z'),
      bytesIn: BigInt(1 * GB),
      bytesOut: BigInt(10 * GB),
    });

    const res = await useCase.execute('client-a', 'c1');

    expect(reader.queries[0]?.username).toBe('actual');
    expect(res.downloadBytes).toBe(10 * GB);
  });

  it('totalBytes SIEMPRE es la suma de daily (el número grande y el gráfico no pueden discrepar)', async () => {
    const { useCase, reader } = buildUseCase();
    for (let day = 1; day <= 5; day++) {
      reader.record({
        sourceUniqueId: `s${day}`,
        username: 'juan.perez',
        startedAt: new Date(`2026-08-0${day}T12:00:00.000Z`),
        bytesIn: BigInt(day * GB),
        bytesOut: BigInt(day * 10 * GB),
      });
    }

    const res = await useCase.execute('client-a', 'c1');

    const sumDaily = res.daily.reduce((acc, d) => acc + d.downloadBytes + d.uploadBytes, 0);
    expect(res.totalBytes).toBe(sumDaily);
    expect(res.totalBytes).toBe(res.downloadBytes + res.uploadBytes);
  });
});
