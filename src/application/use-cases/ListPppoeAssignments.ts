import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeAssignmentDto, toPppoeAssignmentDto } from '@application/dto/pppoe.dto';

/**
 * ListPppoeAssignments — fuente de datos para la tab Asignaciones (GET /api/ip-assignments).
 *
 * Retorna los PPPoE ACTIVAMENTE ASIGNADOS a contratos: filas con
 *   contractId != null AND remoteAddress != null AND status = 'enabled'.
 *
 * El DTO es el wire contract con el FE:
 *   { id, ip, username, contractId, profile, nasId, status, createdAt }
 * donde `ip` = remoteAddress.
 *
 * `password` NUNCA sale en el DTO — frontera de seguridad.
 */
export class ListPppoeAssignments {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(): Promise<PppoeAssignmentDto[]> {
    const services = await this.repo.findAssigned();
    return services.map(s =>
      toPppoeAssignmentDto({
        id:            s.id,
        remoteAddress: s.remoteAddress!,  // non-null: garantizado por findAssigned
        username:      s.username,
        contractId:    s.contractId!,     // non-null: garantizado por findAssigned
        profile:       s.profile,
        nasId:         s.nasId,
        status:        s.status,
        createdAt:     s.createdAt,
      }),
    );
  }
}
