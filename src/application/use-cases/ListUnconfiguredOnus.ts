import { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import { SmartOltOltConfigRepository } from '@domain/ports/SmartOltOltConfigRepository';
import { isHuaweiSn } from '@domain/services/fiberProvisioning';

/** DTO del picker del FE — NUNCA el shape crudo de SmartOLT. */
export interface UnconfiguredOnuListItem {
  sn: string;
  onuTypeName: string | null;
  oltId: string;
  /** Nombre del catálogo local SmartOltOltConfig (null si el OLT no está catalogado). */
  oltName: string | null;
  board: string | null;
  port: string | null;
  ponType: string | null;
  /** Prefijo HWTC — solo Huawei se auto-aprovisiona (K2). */
  huawei: boolean;
  /** huawei && SmartOLT ofrece la acción authorize para esta ONU. */
  authorizable: boolean;
  serviceVlanDefault: number | null;
  /** true → el operador DEBE mandar `vlan` en el POST (CHIVILCOY / OLT sin catálogo). */
  vlanRequired: boolean;
}

/**
 * smartolt-provision (K2) — lista de ONUs sin configurar para el picker del FE,
 * enriquecida con el catálogo local de OLTs (nombre + default de VLAN) y los
 * flags `huawei`/`authorizable` para que el FE marque qué se puede aprovisionar.
 * Las no-Huawei se listan igual (visibilidad de lo detectado), no autorizables.
 */
export class ListUnconfiguredOnus {
  constructor(
    private readonly gateway: OltProvisioningGateway,
    private readonly oltConfigRepo: SmartOltOltConfigRepository,
  ) {}

  async execute(): Promise<UnconfiguredOnuListItem[]> {
    const [onus, olts] = await Promise.all([
      this.gateway.listUnconfiguredOnus(),
      this.oltConfigRepo.list(),
    ]);
    const byOltId = new Map(olts.map(o => [o.smartoltOltId, o]));

    return onus.map(onu => {
      const olt = byOltId.get(onu.oltId) ?? null;
      const huawei = isHuaweiSn(onu.sn);
      return {
        sn: onu.sn,
        onuTypeName: onu.onuTypeName,
        oltId: onu.oltId,
        oltName: olt?.name ?? null,
        board: onu.board,
        port: onu.port,
        ponType: onu.ponType,
        huawei,
        authorizable: huawei && onu.supportsAuthorize,
        serviceVlanDefault: olt?.serviceVlanDefault ?? null,
        vlanRequired: (olt?.serviceVlanDefault ?? null) === null,
      };
    });
  }
}
