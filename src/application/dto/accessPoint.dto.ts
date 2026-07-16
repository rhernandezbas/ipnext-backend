/**
 * contract-node-ap-auto-assign (Fase B, PICK-2) — DTO curado para el catálogo de APs
 * asignables del picker manual. Nunca la entidad `AccessPoint` cruda (que expone
 * `missingSince`/`createdAt`/`updatedAt`, irrelevantes para el picker una vez filtrados).
 */
export interface AccessPointOptionDto {
  id: string;
  name: string;
  mac: string | null;
  networkSiteId: string | null;
}
