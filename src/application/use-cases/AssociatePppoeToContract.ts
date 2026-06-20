import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeServiceNotFoundError, PppoeAlreadyAssociatedError } from '@domain/errors/pppoe';

/**
 * AssociatePppoeToContract — asocia un PPPoE huérfano (adoptado del inventario) a un contrato.
 *
 * Comportamiento ante un PPPoE YA asociado (decisión del proposal):
 *   - mismo contractId  → idempotente: devuelve la fila sin cambios (re-asociar no es un error).
 *   - OTRO contractId   → `PppoeAlreadyAssociatedError` (→ 409). NO robamos el PPPoE en silencio;
 *     mover requiere desasociar primero (operación explícita, futura).
 *   - sin contrato      → setea el contractId.
 */
export class AssociatePppoeToContract {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(pppoeId: string, contractId: string): Promise<PppoeService> {
    const pppoe = await this.repo.findById(pppoeId);
    if (!pppoe) throw new PppoeServiceNotFoundError(pppoeId);

    if (pppoe.contractId !== null) {
      if (pppoe.contractId === contractId) return pppoe; // idempotente: mismo contrato
      throw new PppoeAlreadyAssociatedError(pppoeId, pppoe.contractId);
    }

    const updated = await this.repo.setContractId(pppoeId, contractId);
    // setContractId solo devuelve null si la fila desapareció entre el findById y el update (carrera).
    if (!updated) throw new PppoeServiceNotFoundError(pppoeId);
    return updated;
  }
}
