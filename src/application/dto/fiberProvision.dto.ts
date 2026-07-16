import { z } from 'zod';

/**
 * smartolt-provision (K2) — wire contract del aprovisionamiento de fibra.
 *
 * POST /api/fiber/provision
 *  - vlan: VLAN de servicio explícita (gana sobre el default del catálogo del OLT).
 *    Opcional: sin ella se usa el default; si el OLT no tiene (CHIVILCOY) → 422
 *    FIBER_VLAN_REQUIRED desde el use case.
 *  - dryRun: true → el BE devuelve el PLAN de calls SIN tocar SmartOLT.
 */
export const ProvisionFiberOnuSchema = z.object({
  contractId: z.string().min(1),
  onuSn: z.string().min(1),
  vlan: z.number().int().min(1).max(4094).optional(),
  dryRun: z.boolean().optional(),
});
export type ProvisionFiberOnuBody = z.infer<typeof ProvisionFiberOnuSchema>;

/**
 * PUT /api/fiber/olts/:id — patch parcial del catálogo de OLTs.
 * `null` explícito LIMPIA el campo (semántica del port SmartOltOltConfigRepository);
 * campo omitido = mantener.
 */
export const UpdateSmartOltOltSchema = z.object({
  name: z.string().min(1).optional(),
  serviceVlanDefault: z.number().int().min(1).max(4094).nullable().optional(),
  mgmtVlan: z.number().int().min(1).max(4094).nullable().optional(),
});
export type UpdateSmartOltOltBody = z.infer<typeof UpdateSmartOltOltSchema>;
