import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeUsernameTakenError, PppoeProfileRequiredError, PppoeContractAlreadyHasServiceError } from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { EnsureInternetContractService } from './EnsureInternetContractService';
import { toNasTarget } from './nasTarget';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

export interface CreatePppoeServiceInput {
  contractId: string | null;
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  nasId: string;
}

/**
 * Crea un PPPoE y aprovisiona el plano de control, de forma consistente:
 * DB `pending` → aprovisionamiento → DB `enabled`. Si el aprovisionamiento falla, la fila
 * queda `pending` (visible, reintentable) y el error se propaga — nunca un "OK" mentiroso.
 *
 * El destino se RUTEA por `nas.type`:
 *   - `mikrotik_radius` (NAS migrado a RADIUS) → `orchestrator.createUser` (POST /users:
 *     radcheck + radusergroup + radreply Framed-IP-Address). El `profile` ES el plan/grupo RADIUS.
 *   - resto (`mikrotik_api`, …) → `router.createSecret` (RouterOS `/ppp secret`), como siempre.
 *
 * Guard #4 (pppoe-contract-integrity): cuando `contractId != null`, antes de tocar la DB,
 * verifica que el contrato no tenga ya un PPPoE 'enabled' → PppoeContractAlreadyHasServiceError.
 *
 * Post-alta: llama ensureInternet(contractId, true) best-effort cuando hay contractId.
 */
export class CreatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly ensureInternet: EnsureInternetContractService,
    /** fix-operador-alta: optional repos for recording 'activated' event even when line is already active. */
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(
    input: CreatePppoeServiceInput,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<PppoeService> {
    // 1. `username` es @unique global (un PPPoE no vive en dos routers)
    const dup = await this.repo.findByUsername(input.username);
    if (dup) throw new PppoeUsernameTakenError(input.username);

    // 2. resolver el NAS destino
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    const profile = input.profile ?? null;
    const remoteAddress = input.remoteAddress ?? null;
    const isRadius = routesViaOrchestrator(nas.type);

    // 2b. Un usuario RADIUS NECESITA su grupo/plan (radusergroup): sin `profile` no hay alta.
    //     Validar ANTES de tocar la DB → no dejamos filas `pending` huérfanas por un input inválido.
    if (isRadius && !profile) throw new PppoeProfileRequiredError(input.username);

    // 2c. Guard #4: si el contrato tiene ya un PPPoE enabled, rechazar ANTES de tocar la DB.
    if (input.contractId != null) {
      const existing = await this.repo.findByContract(input.contractId);
      const activeExisting = existing.find(p => p.status === 'enabled');
      if (activeExisting) {
        throw new PppoeContractAlreadyHasServiceError(input.contractId, activeExisting.id);
      }
    }

    const base: PppoeServiceUpsert = {
      username: input.username,
      password: input.password,
      profile,
      remoteAddress,
      nasId: input.nasId,
      contractId: input.contractId ?? null,
    };

    // 3. DB pending → aprovisionar (RADIUS o router según el NAS) → DB confirm
    await this.repo.upsertByUsername({ ...base, status: 'pending' });
    if (isRadius) {
      // `profile` está garantizado no-null por la guarda de arriba.
      await this.orchestrator.createUser({
        username: input.username,
        password: input.password,
        plan: profile!,
        framedIp: remoteAddress,
      });
    } else {
      await this.router.createSecret(toNasTarget(nas), {
        username: input.username,
        password: input.password,
        profile,
        remoteAddress,
      });
    }
    const result = await this.repo.upsertByUsername({ ...base, status: 'enabled' });

    // 4. Best-effort: la línea INTERNET del contrato queda active.
    //    fix-operador-alta: if ensureInternet no-ops (line already active), record 'activated'
    //    event explicitly with actor so the operador is not empty.
    if (input.contractId != null) {
      try {
        const opts = actor ? { actorId: actor.actorId ?? null, actorName: actor.actorName } : undefined;
        const recorded = await this.ensureInternet.execute(input.contractId, true, opts);
        if (!recorded && actor && this.catalogRepo && this.eventRepo) {
          // Line was already active (no-op): still record the 'activated' event with actor.
          try {
            const catalog = await this.catalogRepo.getByName('INTERNET');
            if (catalog) {
              await this.eventRepo.record({
                contractId: input.contractId,
                serviceCatalogId: catalog.id,
                eventType: 'activated',
                actorId: actor.actorId ?? null,
                actorName: actor.actorName ?? '',
                reason: null,
              });
            }
          } catch (innerErr) {
            console.warn('[CreatePppoeService] fallback activated event failed (best-effort):', innerErr);
          }
        }
      } catch (err) {
        console.warn('[CreatePppoeService] ensureInternet(true) falló (best-effort):', err);
      }
    }

    return result;
  }
}
