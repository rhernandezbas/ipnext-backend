import { PrismaUsageMetricsReader } from '@infrastructure/adapters/prisma/PrismaUsageMetricsReader';
import { prisma } from '@infrastructure/database/prisma';

/**
 * portal-usage-metrics — las DOS reglas duras del dato viven en el SQL del
 * adapter REAL, y es ahí donde hay que testearlas.
 *
 * Lección `la-funcion-que-decide-no-es-la-que-se-testea`: los tests de
 * `GetPortalUsageMetrics` ejercitan el gemelo in-memory. Si el mapeo
 * bytesOut->descarga o el `DISTINCT ON ("sourceUniqueId")` se caen del SQL que
 * corre en PRODUCCIÓN, esa suite queda entera en verde y el cliente ve un número
 * inventado. Estos tests capturan la query REAL que el adapter le manda a
 * Postgres (spy sobre `$queryRaw`, sin DB) y assertean su estructura.
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
    username: 'juan.perez',
    from: new Date('2026-08-01T03:00:00.000Z'),
    to: new Date('2026-08-05T14:00:00.000Z'),
  };

  it('REGLA 1 — bytesOut es la DESCARGA y bytesIn la SUBIDA (invertirlos rompe acá)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(cap.sql).toMatch(/SUM\("bytesOut"\)[^,]*AS "downloadBytes"/i);
    expect(cap.sql).toMatch(/SUM\("bytesIn"\)[^,]*AS "uploadBytes"/i);
    // Y la negación explícita: el cruce NO puede existir.
    expect(cap.sql).not.toMatch(/SUM\("bytesIn"\)[^,]*AS "downloadBytes"/i);
    expect(cap.sql).not.toMatch(/SUM\("bytesOut"\)[^,]*AS "uploadBytes"/i);
  });

  it('REGLA 2 — deduplica por sourceUniqueId antes de sumar (contadores ACUMULADOS, no deltas)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(cap.sql).toMatch(/DISTINCT ON \("sourceUniqueId"\)/i);
    // El desempate: el evento MÁS RECIENTE de cada sesión.
    expect(cap.sql).toMatch(/ORDER BY "sourceUniqueId", "startedAt" DESC/i);
    // Y las sumas operan sobre esa CTE deduplicada, no sobre "RadiusEvent" crudo.
    expect(cap.sql).toMatch(/FROM ultimo_por_sesion/i);
  });

  it('el anclaje por username y el rango [from, to) van en el WHERE, como parámetros ligados', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(cap.values).toEqual([QUERY.username, QUERY.from.toISOString(), QUERY.to.toISOString()]);
    expect(cap.sql).toMatch(/WHERE username = \?/i);
    expect(cap.sql).toMatch(/>= \? ::timestamptz/i);
    // Semi-abierto: `<`, nunca `<=` (si no, el evento del instante `to` se cuenta dos veces
    // entre dos ventanas contiguas).
    expect(cap.sql).toMatch(/< \? ::timestamptz/i);
    expect(cap.sql).not.toMatch(/<= \? ::timestamptz/i);
  });

  it('el bucketing por día es en hora de Argentina, no UTC (una sesión de las 22:00 cae en SU día)', async () => {
    const cap = espiar();
    await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(cap.sql).toMatch(
      /"startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America\/Argentina\/Buenos_Aires'/i,
    );
  });

  it('es UNA sola query — nada de N+1 ni de traer las sesiones crudas a Node', async () => {
    espiar();
    await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('mapea las filas a bigint (Postgres devuelve numeric/bigint según el driver)', async () => {
    espiar([
      { date: '2026-08-02', downloadBytes: BigInt(700), uploadBytes: BigInt(30) },
      { date: '2026-08-03', downloadBytes: '100', uploadBytes: 10 },
    ]);

    const res = await new PrismaUsageMetricsReader().dailyUsageByUsername(QUERY);

    expect(res).toEqual([
      { date: '2026-08-02', downloadBytes: 700n, uploadBytes: 30n },
      { date: '2026-08-03', downloadBytes: 100n, uploadBytes: 10n },
    ]);
  });
});
