import type { ChatwootGateway, ChatwootLabelDto } from '@domain/ports/ChatwootGateway';

/**
 * campaign-chatwoot-label (5.2, CLBL-1, molde `ListTemplates`) — lista el
 * catálogo REAL de labels de la cuenta de Chatwoot. Delega ÚNICAMENTE en el
 * port, retorna tal cual (sin filtrar/mapear) — alimenta el picker del
 * composer FE (`ChatwootLabelSelector`, D6).
 *
 * Gate RBAC `messaging.templates` (CLBL-7) — se aplica en la ruta (Batch 5),
 * no acá.
 */
export class ListChatwootLabels {
  constructor(private readonly chatwootGateway: ChatwootGateway) {}

  async execute(): Promise<ChatwootLabelDto[]> {
    return this.chatwootGateway.listAccountLabels();
  }
}
