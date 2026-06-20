import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from './EnsureInternetContractService';

/**
 * DeassociatePppoeFromContract (#2) — desvincula un PPPoE de su contrato.
 *
 * Operación: setea `contractId=null` (clearContractId). NO toca el secret RADIUS ni el `status`
 * (el PPPoE sigue 'enabled', vuelve a ser huérfano re-asociable). La baja real es un flujo distinto.
 *
 * Ownership: verifica que el PPPoE pertenece a `contractId` antes de desvincular.
 * Si no pertenece → PppoeServiceNotFoundError (mismo error que "no existe" para no exponer datos).
 *
 * Post-desvincular: llama ensureInternet(contractId, false) best-effort — la línea INTERNET
 * del contrato queda 'inactive'.
 */
export class DeassociatePppoeFromContract {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly ensureInternet: EnsureInternetContractService,
  ) {}

  async execute(pppoeId: string, contractId: string): Promise<PppoeService> {
    const pppoe = await this.repo.findById(pppoeId);
    if (!pppoe) throw new PppoeServiceNotFoundError(pppoeId);

    // Ownership check: el PPPoE debe pertenecer exactamente a este contrato.
    if (pppoe.contractId !== contractId) {
      throw new PppoeServiceNotFoundError(pppoeId);
    }

    const updated = await this.repo.clearContractId(pppoeId);
    // clearContractId solo devuelve null si la fila desapareció entre el findById y el update (carrera).
    if (!updated) throw new PppoeServiceNotFoundError(pppoeId);

    // Best-effort: la línea INTERNET del contrato queda inactive.
    try {
      await this.ensureInternet.execute(contractId, false);
    } catch (err) {
      console.warn('[DeassociatePppoeFromContract] ensureInternet(false) falló (best-effort):', err);
    }

    return updated;
  }
}
