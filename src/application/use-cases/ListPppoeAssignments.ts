import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeAssignmentDto, toPppoeAssignmentDto } from '@application/dto/pppoe.dto';

export interface ListPppoeAssignmentsParams {
  page: number;
  pageSize: number;
  search?: string;
  nasId?: string;
}

export interface ListPppoeAssignmentsResult {
  data: PppoeAssignmentDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * ListPppoeAssignments — fuente de datos para la tab Asignaciones (GET /api/ip-assignments).
 *
 * Retorna los PPPoE ACTIVAMENTE ASIGNADOS a contratos (paginados): filas con
 *   contractId != null AND remoteAddress != null AND status = 'enabled'.
 *
 * Filtros opcionales: `search` (username | remoteAddress | contractId, case-insensitive),
 * `nasId` (exacto). Orden estable: username asc.
 *
 * Wire contract FE: { data: PppoeAssignmentDto[], total, page, pageSize }
 * donde cada ítem tiene `ip` = remoteAddress.
 *
 * `password` NUNCA sale en el DTO — frontera de seguridad.
 */
export class ListPppoeAssignments {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(params: ListPppoeAssignmentsParams): Promise<ListPppoeAssignmentsResult> {
    const { data: services, total } = await this.repo.findAssignedPaginated(params);

    const data = services.map(s =>
      toPppoeAssignmentDto({
        id:            s.id,
        remoteAddress: s.remoteAddress!,  // non-null: garantizado por findAssignedPaginated
        username:      s.username,
        contractId:    s.contractId!,     // non-null: garantizado por findAssignedPaginated
        profile:       s.profile,
        nasId:         s.nasId,
        status:        s.status,
        createdAt:     s.createdAt,
      }),
    );

    return { data, total, page: params.page, pageSize: params.pageSize };
  }
}
