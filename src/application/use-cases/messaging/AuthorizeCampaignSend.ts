import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import { CampaignNotFoundError, BulkRecipientsNotPermittedError } from '@domain/errors/messaging-bulk';
import {
  forbiddenBulkTargets,
  BULK_SUPER_ADMIN_SENTINEL,
  type BulkTargetLike,
} from '@domain/services/bulkRecipientAuthorization';

export interface AuthorizeCampaignSendInput {
  campaignId: string;
  /**
   * bulk-granular-perms — acciones `messaging` del USUARIO QUE DISPARA el envío
   * (o `['*']`/`Set(['*'])` para super_admin). `undefined` → sin enforcement
   * (backcompat de tests/callers directos; la ruta SIEMPRE lo pasa en prod).
   */
  allowedBulkActions?: Set<string> | string[];
}

/**
 * bulk-granular-perms — re-chequeo COMPLETO de permisos granulares en el ENVÍO
 * (`POST /campaigns/:id/send`), ANTES de disparar el `CampaignRunner`. El creador
 * de la campaña pudo tener permisos que el sender NO tiene, así que se re-valida
 * contra el snapshot persistido (`recipientStatuses` + `hasRawRecipients`).
 *
 * Reconstruye destinatarios SINTÉTICOS desde el snapshot (un placeholder por cada
 * estado presente + uno número-crudo si hubo) y aplica `forbiddenBulkTargets`. Si
 * hay algún prohibido → `BulkRecipientsNotPermittedError` (403), sin disparar el
 * envío. Puro salvo la lectura del campaign repo (DIP: depende del PORT).
 */
export class AuthorizeCampaignSend {
  constructor(private readonly campaignRepo: CampaignRepository) {}

  async execute(input: AuthorizeCampaignSendInput): Promise<void> {
    if (input.allowedBulkActions === undefined) return; // backcompat: sin enforcement

    const allowed = input.allowedBulkActions instanceof Set
      ? input.allowedBulkActions
      : new Set(input.allowedBulkActions);

    // super_admin bypassa el guard SIEMPRE — ANTES de leer el snapshot: envía
    // cualquier campaña, incluidas las pre-migración sin snapshot (F1).
    if (allowed.has(BULK_SUPER_ADMIN_SENTINEL)) return;

    const campaign = await this.campaignRepo.findById(input.campaignId);
    if (!campaign) throw new CampaignNotFoundError(input.campaignId);

    // F1 (fail-closed) — una campaña con destinatarios (`total > 0`) pero snapshot
    // en su DEFAULT (`recipientStatuses:[]` + `hasRawRecipients:false`) es una
    // campaña creada ANTES de esta migración: `forbiddenBulkTargets(allowed, [])`
    // devolvería `[]` y dejaría enviar SIN chequear ningún estado (BYPASS).
    // `CreateCampaign` post-feature SIEMPRE puebla al menos una señal cuando hay
    // destinatarios, así que este estado es imposible de producir hoy → si no se
    // pueden determinar los estados, NO se puede autorizar: bloqueo defensivo.
    if (
      campaign.total > 0 &&
      campaign.recipientStatuses.length === 0 &&
      !campaign.hasRawRecipients
    ) {
      throw new BulkRecipientsNotPermittedError(['desconocido']);
    }

    // Destinatarios sintéticos: uno por estado presente + uno número-crudo si hubo.
    const synthetic: BulkTargetLike[] = campaign.recipientStatuses.map((status) => ({
      clientId: 'x',
      status,
    }));
    if (campaign.hasRawRecipients) {
      synthetic.push({ clientId: null, status: 'no_cliente' });
    }

    const forbidden = forbiddenBulkTargets(allowed, synthetic);
    if (forbidden.length > 0) {
      throw new BulkRecipientsNotPermittedError(forbidden);
    }
  }
}
