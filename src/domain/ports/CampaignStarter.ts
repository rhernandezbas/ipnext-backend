/**
 * external-bulk-messaging (D4.a) — interfaz ESTRUCTURAL para arrancar/reanudar
 * una campaña. `CampaignRunner` (infrastructure/scheduling/) la satisface
 * estructuralmente SIN cambios (mismo truco que `CampaignSender` en
 * `CampaignRunner.ts:7`) — un use case NUNCA puede importar `CampaignRunner`
 * directamente (DIP: application no depende de infrastructure).
 */
export interface CampaignStarter {
  start(campaignId: string): Promise<{ accepted: boolean }>;
}
