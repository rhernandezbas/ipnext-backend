/**
 * EPIC v3 fix wave W2 — `ChangePortalTvPassword`: wrapper PORTAL del PUT de la
 * clave de TV. `ChangeTvPassword` (#65, staff) solo exige ownership del
 * contrato; con un contrato PROPIO pero SIN TV el PATCH a Gigared salía igual
 * (la cuenta es per-customer) y el snapshot local del contrato que SÍ tiene TV
 * quedaba stale en silencio. El wrapper exige el slot TV ACTIVO del CONTRATO
 * del param — el MISMO resolver que el GET (`GetPortalTvStatus`) — ANTES de
 * delegar; sin TV -> `TvNotLinkedError` (404 TV_NOT_LINKED, consistente con el
 * GET) y el staff (`ChangeTvPassword` directo) queda intacto.
 */
import { ChangePortalTvPassword } from '@application/use-cases/portal/ChangePortalTvPassword';
import { TvNotLinkedError } from '@domain/errors/gigared';
import { ContractNotFoundError } from '@domain/errors/contractServices';

function buildSut(opts?: {
  status?: { hasTv: boolean; login: string | null };
  statusError?: Error;
}) {
  const getStatus = {
    execute: jest.fn(async () => {
      if (opts?.statusError) throw opts.statusError;
      return opts?.status ?? { hasTv: true, login: 'GIGA12345' };
    }),
  };
  const delegate = { execute: jest.fn(async () => ({ password: 'clave1234', persisted: true })) };
  const sut = new ChangePortalTvPassword(getStatus, delegate);
  return { sut, getStatus, delegate };
}

describe('ChangePortalTvPassword (W2)', () => {
  it('contrato con TV -> delega en ChangeTvPassword con el clientId y el input EXACTOS', async () => {
    const { sut, getStatus, delegate } = buildSut();

    await sut.execute('client-a', { contractId: 'c1', password: 'clave1234' });

    expect(getStatus.execute).toHaveBeenCalledWith('client-a', 'c1');
    expect(delegate.execute).toHaveBeenCalledWith('client-a', { contractId: 'c1', password: 'clave1234' });
  });

  it('contrato propio SIN TV (hasTv:false) -> TvNotLinkedError y el delegate JAMÁS corre', async () => {
    const { sut, delegate } = buildSut({ status: { hasTv: false, login: null } });

    await expect(sut.execute('client-a', { contractId: 'c1', password: 'clave1234' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    expect(delegate.execute).not.toHaveBeenCalled();
  });

  it('contrato ajeno/inexistente -> propaga el ContractNotFoundError del resolver (404 indistinguible), delegate intacto', async () => {
    const { sut, delegate } = buildSut({ statusError: new ContractNotFoundError('c-ajeno') });

    await expect(sut.execute('client-a', { contractId: 'c-ajeno', password: 'clave1234' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(delegate.execute).not.toHaveBeenCalled();
  });
});
