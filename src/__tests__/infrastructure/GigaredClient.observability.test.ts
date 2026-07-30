/**
 * gigared-tv-cic-reuse (Fase 5, spec OBS-1) — observabilidad de los rechazos del partner.
 *
 * WHY: el 2026-07-30 el alta de TV estuvo rota al 100% y **no dejó UNA sola línea en los logs
 * de producción**. La causa es doble, y las dos están en `mapError`:
 *
 *   1. la rama `cic-ownership-error` (403) hace `return new GigaredNotFoundError()` y RETORNA
 *      ANTES de llegar al `console.warn`;
 *   2. el warn genérico está guardado por `if (status !== 404)`, así que ningún 404 se loguea.
 *
 * Resultado: el 403 que el partner devolvía por el CIC corrupto se convertía en un 404 mudo.
 * El diagnóstico terminó necesitando probes manuales contra la API del partner.
 *
 * El único 404 que DEBE seguir siendo silencioso es `empty-accounts_list`: es un resultado de
 * cero filas esperado (`listAccounts` lo traduce a `[]`), no una falla.
 */
import { GigaredClient } from '@infrastructure/adapters/gigared/GigaredClient';
import { InMemoryGigaredConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository';
import { GigaredNotFoundError } from '@domain/errors/gigared';

type Resp = { data: unknown };

function axiosError(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data, headers: {} } };
}

function makeHttp() {
  return {
    get: jest.fn<Promise<Resp>, [string, unknown?]>(),
    post: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    patch: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    put: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    delete: jest.fn<Promise<Resp>, [string, unknown?]>(),
  };
}

function makeClient(http: ReturnType<typeof makeHttp>) {
  const cfg = new InMemoryGigaredConfigRepository();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  cfg.update({ apiKey: 'mykey1234' });
  return new GigaredClient({
    configProvider: cfg,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    http: http as any,
    maxRateLimitRetries: 0,
    backoffMs: 1,
    _sleep: async () => {},
  });
}

describe('gigared-tv-cic-reuse OBS-1 — mapError deja rastro de los rechazos del partner', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('OBS-1.1 — el 403 cic-ownership-error SE LOGUEA (era el rechazo mudo del incidente)', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(403, {
        type: 'https://partners.gigaredsa.com.ar/errors/cic-ownership-error',
        title: 'Error de propiedad de CIC',
        detail: 'El revendedor no posee esta cuenta',
      }),
    );

    await expect(makeClient(http).getAccountByCic('00065470 4')).rejects.toBeInstanceOf(
      GigaredNotFoundError,
    );

    expect(warn).toHaveBeenCalled();
    const linea = warn.mock.calls.map(c => c.join(' ')).join(' | ');
    expect(linea).toContain('cic-ownership-error');
    expect(linea).toContain('El revendedor no posee esta cuenta');
  });

  it('el 403 cic-ownership SIGUE mapeando a GigaredNotFoundError (no cambia el contrato)', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(403, { type: 'https://x/errors/cic-ownership-error', detail: 'no posee' }),
    );

    const err = await makeClient(http).getAccountByCic('0006677401').catch(e => e);
    expect(err).toBeInstanceOf(GigaredNotFoundError);
  });

  /**
   * FIX WAVE 2 (M1) — LA PREMISA DEL REINTENTO, VERIFICADA DONDE SE PRODUCE.
   *
   * `cicNotOwned` es lo único que habilita el reintento acotado del alta, y este adapter es el
   * ÚNICO lugar de producción que lo pone en `true`. Los tests del use case la escriben A MANO
   * en sus fixtures: si alguien borra el `, true` de acá, esos tests siguen verdes y el
   * reintento muere ENTERO en producción (todo 403 → 503, cero reintentos), con el CI feliz.
   *
   * Es exactamente el pecado del test tautológico original, una capa más abajo: no alcanza con
   * que el consumidor asuma la premisa, hay que verificar que el productor la emita.
   */
  it('M1 — el 403 cic-ownership marca cicNotOwned=true (habilita el reintento)', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(403, {
        type: 'https://partners.gigaredsa.com.ar/errors/cic-ownership-error',
        detail: 'El revendedor no posee esta cuenta',
      }),
    );

    const err = await makeClient(http).getAccountByCic('00065470 4').catch(e => e);
    expect(err).toBeInstanceOf(GigaredNotFoundError);
    expect((err as GigaredNotFoundError).cicNotOwned).toBe(true);
  });

  it('M1 — el 424 "no se encontró" NO marca cicNotOwned (estado indeterminado, sin reintento)', async () => {
    // 424 = el partner ACEPTÓ y su downstream (el CUA) falló ⇒ pudo haber creado la cuenta.
    // Reintentar con otro CIC ahí es el doble cobro que F3 evita.
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(424, {
        type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
        detail: 'no se encontró el abonado',
      }),
    );

    const err = await makeClient(http).getAccountByCic('0006677401').catch(e => e);
    expect(err).toBeInstanceOf(GigaredNotFoundError);
    expect((err as GigaredNotFoundError).cicNotOwned).toBe(false);
  });

  it('M1 — el 404 pelado tampoco marca cicNotOwned', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(axiosError(404, { detail: 'no existe' }));

    const err = await makeClient(http).getAccountByCic('0006677401').catch(e => e);
    expect((err as GigaredNotFoundError).cicNotOwned).toBe(false);
  });

  /**
   * FIX WAVE F7 — OBS-1.2 se REVIERTE, y el spec se corrige con él.
   *
   * La versión original decía "todo 404 debe loguearse". El review mostró que eso entierra el
   * fix en su propio ruido: el 404 es el HAPPY PATH de `GetGigaredCustomerAccount` (el panel de
   * CADA cliente sin TV), del probe idempotente de cada alta y del probe del destino en
   * `TransferTvToCustomer`. Miles de líneas esperadas sepultando la única que importaba.
   *
   * La señal que de verdad faltaba era el 403 `cic-ownership-error` (OBS-1.1), y ésa se loguea.
   */
  it('F7 — un 404 genérico NO se loguea (es el happy path de "cliente sin TV")', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(axiosError(404, { detail: 'no existe' }));

    await expect(makeClient(http).getAccountByCic('0006677401')).rejects.toBeInstanceOf(
      GigaredNotFoundError,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('F7 — los NO-404 sí se siguen logueando (no se perdió observabilidad real)', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(axiosError(500, { detail: 'boom' }));

    await expect(makeClient(http).getAccountByCic('0006677401')).rejects.toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it('OBS-1.3 — el 404 empty-accounts_list NO se loguea y listAccounts sigue devolviendo []', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(404, { type: 'https://partners.gigaredsa.com.ar/errors/empty-accounts_list' }),
    );

    await expect(makeClient(http).listAccounts({ status: 'unregistered' })).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('el empty-accounts_list SÍ es un not-found para una lectura puntual (no se rompe esa semántica)', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(
      axiosError(404, { type: 'https://partners.gigaredsa.com.ar/errors/empty-accounts_list' }),
    );

    await expect(makeClient(http).getAccountByCic('0006677401')).rejects.toBeInstanceOf(
      GigaredNotFoundError,
    );
  });
});
