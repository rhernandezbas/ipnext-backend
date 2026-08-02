import type { EquipmentRebootReason } from '@domain/errors/equipment';

/**
 * portal-equipment-reboot — `GET /api/portal/equipment/:contractId`.
 * Deriva de `getOnuWifiStatus` (mismo `WifiManagementPort` que wifi-self-service,
 * cache 60s) — `online` sale de ahí directo, no de una llamada propia.
 */
export type PortalEquipmentStatusDto =
  | { eligible: false; reason: EquipmentRebootReason }
  | { eligible: true; online: boolean; model: string | null };
