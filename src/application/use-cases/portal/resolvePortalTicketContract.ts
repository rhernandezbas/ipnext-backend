import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import { PortalContractRequiredError, PortalContractNotFoundError } from '@domain/errors/portal.errors';

export interface ResolvedPortalContract {
  id: string;
  plan: string;
}

/**
 * resolvePortalTicketContract — regla de contrato COMPARTIDA entre
 * `CreatePortalTicket` (Fase 5.2) e `InterestInPortalPromo` (portal-promos):
 * "para abrir un reclamo debería seleccionar el contrato primero". Extraída
 * como función pura para que los DOS caminos que crean un `Ticket` desde el
 * portal (el formulario libre de reclamo Y el botón "Me interesa" de una
 * promo) apliquen EXACTAMENTE la misma regla — mismo criterio que
 * `buildSegmentWhere` compartido entre `listSegmentRecipients` y
 * `clientMatchesSegment`: una regla de negocio, UNA sola implementación.
 *
 *   - Cliente CON ≥1 contrato: `contractId` es REQUERIDO
 *     (`PortalContractRequiredError` si falta/viene vacío).
 *   - El `contractId` recibido DEBE pertenecer al cliente del token. Ajeno o
 *     inexistente ⇒ `PortalContractNotFoundError` — UN SOLO error para los
 *     dos casos (anti-enumeración).
 *   - Cliente SIN contratos: se acepta sin `contractId` (contract queda null).
 *     Si igual manda uno, también es `PortalContractNotFoundError` (nunca se
 *     ignora un id ajeno en silencio).
 */
export async function resolvePortalTicketContract(
  customers: Pick<CustomerRepository, 'listContracts'>,
  clientId: string,
  requestedContractId: string | null,
): Promise<ResolvedPortalContract | null> {
  const contracts = await customers.listContracts(clientId);

  if (contracts.length > 0) {
    if (!requestedContractId) {
      throw new PortalContractRequiredError();
    }
    const found = contracts.find((c) => c.id === requestedContractId) ?? null;
    if (!found) {
      throw new PortalContractNotFoundError();
    }
    return found;
  }

  if (requestedContractId) {
    throw new PortalContractNotFoundError();
  }

  return null;
}
