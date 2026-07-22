import type { ChatwootGateway, ChatwootLabelDto } from '@domain/ports/ChatwootGateway';
import { InvalidChatwootLabelError } from '@domain/errors/messaging-bulk';

export interface CreateChatwootLabelInput {
  title: string;
  color: string;
}

/** `#RGB` o `#RRGGBB` — mismo criterio de validación barata que el resto del repo. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * campaign-chatwoot-label (5.3, CLBL-2) — crea la ficha completa de un label
 * en el catálogo REAL de Chatwoot. Validación LOCAL barata (title no-vacío,
 * color hex) ANTES de tocar el gateway — NO re-consulta el catálogo (D5.a,
 * distinta de la Decisión D del pick en `CreateCampaign`).
 *
 * Nota (dato verificado del orquestador 2026-07-22, Chatwoot v4.13
 * `app/models/label.rb`): `title` se downcasea automáticamente vía
 * `before_validation` + formato `UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE`
 * (sin espacios) + unicidad por cuenta. Este use case pasa-through el `title`
 * TAL CUAL — NO normaliza, NO valida charset; Chatwoot downcasea/rechaza del
 * lado servidor (un rechazo, incl. duplicado, propaga `ChatwootUnavailableError`
 * vía el adapter, D2/D8). La normalización visible es responsabilidad del FE
 * (mini-modal, tarea FE.3).
 */
export class CreateChatwootLabel {
  constructor(private readonly chatwootGateway: ChatwootGateway) {}

  async execute(input: CreateChatwootLabelInput): Promise<ChatwootLabelDto> {
    if (input.title.trim().length === 0) {
      throw new InvalidChatwootLabelError('title no puede estar vacío');
    }
    if (!HEX_COLOR_RE.test(input.color)) {
      throw new InvalidChatwootLabelError('color debe ser un hex válido (#RGB o #RRGGBB)');
    }
    return this.chatwootGateway.createAccountLabel({ title: input.title, color: input.color });
  }
}
