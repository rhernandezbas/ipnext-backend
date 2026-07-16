/**
 * smartolt-provision (K2) — catálogo local de OLTs SmartOLT: VLAN de servicio
 * default y VLAN de management por OLT. Seed empírico por migración
 * (MERCEDES1/CHIVILCOY X2/Estudiantes/AGOTE X2); editable en runtime por la
 * config de fibra (GET/PUT /api/fiber/olts).
 *
 * `serviceVlanDefault` null = SIN default (CHIVILCOY: VLAN heterogénea por
 * cliente — el operador la elige en cada aprovisionamiento).
 * `mgmtVlan` null = mgmt IP desconocida/no aplica → el paso setMgmtIp se SALTA.
 */
export interface SmartOltOltConfig {
  id: string;
  /** Id de la OLT en SmartOLT ("1", "3", "5", "7") — único. */
  smartoltOltId: string;
  name: string;
  serviceVlanDefault: number | null;
  mgmtVlan: number | null;
}

export interface UpdateSmartOltOltConfigInput {
  name?: string;
  /** null = limpiar el default (VLAN pasa a ser obligatoria en el request). */
  serviceVlanDefault?: number | null;
  /** null = limpiar (el paso mgmt IP se salta). */
  mgmtVlan?: number | null;
}

export interface SmartOltOltConfigRepository {
  list(): Promise<SmartOltOltConfig[]>;
  findBySmartoltOltId(smartoltOltId: string): Promise<SmartOltOltConfig | null>;
  /** Patch parcial por id local. Devuelve la fila actualizada, o null si no existe. */
  update(id: string, patch: UpdateSmartOltOltConfigInput): Promise<SmartOltOltConfig | null>;
}
