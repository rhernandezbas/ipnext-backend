import { PrismaUsageMetricsReader } from '@infrastructure/adapters/prisma/PrismaUsageMetricsReader';
import { prisma } from '@infrastructure/database/prisma';

/**
 * portal-usage-metrics — las reglas duras del dato viven en el SQL del adapter
 * REAL, y es ahí donde hay que testearlas.
 *
 * Lección `la-funcion-que-decide-no-es-la-que-se-testea`: los tests de
 * `GetPortalUsageMetrics` ejercitan el gemelo in-memory. Si el mapeo
 * bytesOut->descarga, el `DISTINCT ON ("sourceUniqueId")` o la ventana POR
 * SOLAPAMIENTO se caen del SQL que corre en PRODUCCIÓN, esa suite queda entera
 * en verde y el cliente ve un número inventado (o un 0 — el bug C1). Estos tests
 * capturan la query REAL que el adapter le manda a Postgres (spy sobre
 * `$queryRaw`, sin DB) y assertean su estructura. El PRORRATEO no se testea acá:
 * es `prorateUsageSessions`, UNA función pura compartida por el camino de prod y
 * el gemelo, ejercitada por la suite del use case.
 *
 * Los comentarios SQL se filtran antes de matchear: si no, un `-- SUM(bytesOut)`
 * en un docblock haría pasar un test sobre código borrado.
 */
describe('PrismaUsageMetricsReader — el SQL que corre en prod', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Quita los comentarios `--` y normaliza espacios: se matchea CÓDIGO, no prosa. */
  function sqlDesnudo(strings: TemplateStringsArray): string {
    return strings
      .join(' ? ')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function espiar(rows: unknown[] = []) {
    const capturado: { sql: string; values: unknown[] } = { sql: '', values: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(prisma, '$queryRaw').mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
      capturado.sql = sqlDesnudo(strings);
      capturado.values = values;
      return rows;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    return capturado;
  }

  const QUERY = {
    usernames: ['juan.perez', 'juan.perez.viejo'],
    from: new Date('2026-08-01T03:00:00.000Z'),
    to: new Date('2026-08-05T14:00:00.000Z'),
  };

  it('REGLA 1 — bytesOut es la DESCARGA y bytesIn la SUBIDA (invertirlos rompe acá)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    expect(cap.sql).toMatch(/"bytesOut"\s+AS "downloadBytes"/i);
    expect(cap.sql).toMatch(/"bytesIn"\s+AS "uploadBytes"/i);
    // Y la negación explícita: el cruce NO puede existir.
    expect(cap.sql).not.toMatch(/"bytesIn"\s+AS "downloadBytes"/i);
    expect(cap.sql).not.toMatch(/"bytesOut"\s+AS "uploadBytes"/i);
  });

  it('REGLA 2 — deduplica por sourceUniqueId (contadores ACUMULADOS, no deltas)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    expect(cap.sql).toMatch(/DISTINCT ON \("sourceUniqueId"\)/i);
    // El desempate: el evento MÁS RECIENTE de cada sesión.
    expect(cap.sql).toMatch(/ORDER BY "sourceUniqueId", "startedAt" DESC/i);
  });

  it('C1 — la ventana es POR SOLAPAMIENTO: startedAt < to AND (stoppedAt IS NULL OR stoppedAt >= from)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    // La sesión viva (stoppedAt NULL) solapa SIEMPRE; la nacida el mes anterior
    // entra si sigue viva o si murió dentro del mes. `startedAt >= from` era el bug.
    expect(cap.sql).toMatch(/"startedAt" < \( \? ::timestamptz AT TIME ZONE 'UTC'\)/i);
    expect(cap.sql).toMatch(/"stoppedAt" IS NULL OR "stoppedAt" >= \( \? ::timestamptz AT TIME ZONE 'UTC'\)/i);
    expect(cap.sql).not.toMatch(/"startedAt" >=/i);
  });

  it('W1 — el rango es SARGABLE: se convierte el PARÁMETRO, nunca la columna (el índice [username, startedAt] sirve el rango)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    // La forma rota era `("startedAt" AT TIME ZONE 'UTC') >= ?`: envolver la
    // COLUMNA le esconde el rango al índice.
    expect(cap.sql).not.toMatch(/"startedAt" AT TIME ZONE/i);
    expect(cap.sql).not.toMatch(/"stoppedAt" AT TIME ZONE/i);
  });

  it('el anclaje es por TODOS los usernames del contrato (ANY), como parámetro ligado', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    expect(cap.sql).toMatch(/WHERE username = ANY\( \? \)/i);
    expect(cap.values).toEqual([QUERY.usernames, QUERY.to.toISOString(), QUERY.from.toISOString()]);
  });

  it('NO agrega en SQL: trae las sesiones solapantes crudas (pocas filas por username/mes) y el prorrateo es la función compartida', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    // La agregación dejó de ser un GROUP BY por día: el prorrateo por fracción
    // temporal + reparto uniforme vive en `prorateUsageSessions` (compartida con
    // el gemelo in-memory). Si esto vuelve a agregarse en SQL, la lógica se
    // duplica y puede driftear en silencio.
    expect(cap.sql).not.toMatch(/GROUP BY/i);
    expect(cap.sql).not.toMatch(/SUM\(/i);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // UNA sola query, sin N+1
  });

  it('mapea las filas a UsageSession con bytes bigint (Postgres devuelve numeric/bigint/string según el driver)', async () => {
    const startedA = new Date('2026-07-26T14:00:00.000Z');
    const stoppedB = new Date('2026-08-03T14:00:00.000Z');
    espiar([
      { startedAt: startedA, stoppedAt: null, downloadBytes: BigInt(700), uploadBytes: BigInt(30) },
      { startedAt: new Date('2026-08-03T10:00:00.000Z'), stoppedAt: stoppedB, downloadBytes: '100', uploadBytes: 10 },
    ]);

    const res = await new PrismaUsageMetricsReader().sessionsOverlappingRange(QUERY);

    expect(res).toEqual([
      { startedAt: startedA, stoppedAt: null, downloadBytes: 700n, uploadBytes: 30n },
      { startedAt: new Date('2026-08-03T10:00:00.000Z'), stoppedAt: stoppedB, downloadBytes: 100n, uploadBytes: 10n },
    ]);
  });

  it('con CERO usernames no toca la base (no hay a quién preguntarle)', async () => {
    espiar();
    const res = await new PrismaUsageMetricsReader().sessionsOverlappingRange({ ...QUERY, usernames: [] });

    expect(res).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
