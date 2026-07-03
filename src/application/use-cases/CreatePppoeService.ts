import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeUsernameTakenError, PppoeProfileRequiredError, PppoeContractAlreadyHasServiceError } from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import type { IpKind } from '@domain/entities/network';
import { EnsureInternetContractService } from './EnsureInternetContractService';
import { toNasTarget } from './nasTarget';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { FindFreeIp } from './FindFreeIp';

export interface CreatePppoeServiceInput {
  contractId: string | null;
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  /**
   * pppoe-preprovision (D3): null = PRE-PROVISIÓN "pendiente de instalación" — el usuario va al
   * RADIUS central SIN Framed-IP y el watcher lo adopta cuando conecta por primera vez.
   */
  nasId: string | null;
  /**
   * pppoe-preprovision (D2): tipo de IP elegido ('cgnat'|'public'). El wire lo exige (zod 422);
   * acá es opcional con default 'cgnat' para no romper callers/fixtures legacy.
   */
  ipTypePreference?: IpKind;
}

/**
 * Crea un PPPoE y aprovisiona el plano de control, de forma consistente:
 * DB `pending` → aprovisionamiento → DB `enabled`. Si el aprovisionamiento falla, la fila
 * queda `pending` (visible, reintentable) y el error se propaga — nunca un "OK" mentiroso.
 *
 * El destino se RUTEA por `nas.type`:
 *   - `radius_orchestrator` (NAS migrado a RADIUS) → `orchestrator.createUser` (POST /users:
 *     radcheck + radusergroup + radreply Framed-IP-Address). El `profile` ES el plan/grupo RADIUS.
 *   - resto (`mikrotik_api`, …) → `router.createSecret` (RouterOS `/ppp secret`), como siempre.
 *
 * pppoe-preprovision (D3): `nasId: null` = pre-provisión. SIEMPRE va al RADIUS central
 * (createUser con framedIp null — el NAS asigna una IP temporal de su pool fallback al conectar)
 * y persiste `{nasId: null, remoteAddress: null, ipMode: 'fixed', ipTypePreference}`. NO llama
 * FindFreeIp (no hay pool sin NAS). El servicio nace `enabled`; "pendiente de instalación" es la
 * DERIVACIÓN `nasId === null`, no un status nuevo.
 *
 * pppoe-preprovision (S1.4): con NAS radius y SIN remoteAddress pedida, la IP se asigna
 * server-side con `FindFreeIp(nas, ipTypePreference)` (antes quedaba 'fixed' con framedIp null
 * — estado cojo). El flujo con remoteAddress explícita queda intacto. sqlippool-cleanup: el
 * modo pool fue descartado; toda alta radius es ipMode='fixed'.
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
    /**
     * pppoe-preprovision (S1.4): allocator server-side del alta. Opcional para back-compat con
     * fixtures legacy; en prod SIEMPRE viene wired (composition test) — sin él, la rama
     * "radius sin pool-mode y sin IP" degrada al comportamiento viejo (framedIp null).
     */
    private readonly findFreeIp?: FindFreeIp,
  ) {}

  async execute(
    input: CreatePppoeServiceInput,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<PppoeService> {
    // 1. `username` es @unique global (un PPPoE no vive en dos routers)
    const dup = await this.repo.findByUsername(input.username);
    if (dup) throw new PppoeUsernameTakenError(input.username);

    const profile = input.profile ?? null;
    const ipTypePreference: IpKind = input.ipTypePreference ?? 'cgnat';

    // ── pppoe-preprovision (D3): sin NAS = pre-provisión ─────────────────────────────────────
    if (input.nasId === null || input.nasId === undefined) {
      // Un usuario del RADIUS central NECESITA su plan/grupo (radusergroup) — S1.3.
      if (!profile) throw new PppoeProfileRequiredError(input.username);
      await this.guardContractFree(input.contractId ?? null);

      const base: PppoeServiceUpsert = {
        username: input.username,
        password: input.password,
        profile,
        remoteAddress: null,
        nasId: null,
        contractId: input.contractId ?? null,
        ipMode: 'fixed',
        ipTypePreference,
      };
      // DB pending → RADIUS central SIN Framed-IP (conecta con IP temporal del pool fallback
      // del NAS donde se instale; el watcher lo adopta al ver su primera sesión) → DB enabled.
      await this.repo.upsertByUsername({ ...base, status: 'pending' });
      await this.orchestrator.createUser({
        username: input.username,
        password: input.password,
        plan: profile,
        framedIp: null,
      });
      const result = await this.repo.upsertByUsername({ ...base, status: 'enabled' });
      await this.activateInternet(input.contractId ?? null, actor);
      return result;
    }

    // ── Flujo CON NAS (intacto + ipTypePreference persistido) ────────────────────────────────
    // 2. resolver el NAS destino
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    let remoteAddress = input.remoteAddress ?? null;
    const isRadius = routesViaOrchestrator(nas.type);

    // 2b. Un usuario RADIUS NECESITA su grupo/plan (radusergroup): sin `profile` no hay alta.
    //     Validar ANTES de tocar la DB → no dejamos filas `pending` huérfanas por un input inválido.
    if (isRadius && !profile) throw new PppoeProfileRequiredError(input.username);

    // 2c. Guard #4: si el contrato tiene ya un PPPoE enabled, rechazar ANTES de tocar la DB.
    await this.guardContractFree(input.contractId ?? null);

    // 2d. pppoe-preprovision (S1.4): NAS radius SIN IP pedida → la IP se asigna server-side del
    //     pool del TIPO elegido (la preferencia manda el pool). Falla del allocator
    //     (NO_POOL_FOR_NAS_TYPE / NO_FREE_IP) → propaga ANTES de tocar DB/RADIUS.
    //     sqlippool-cleanup: toda alta radius es ipMode='fixed' (el modo pool fue descartado).
    if (isRadius && remoteAddress == null && this.findFreeIp) {
      remoteAddress = await this.findFreeIp.execute({ nasId: nas.id, type: ipTypePreference });
    }

    const framedIp = remoteAddress;

    const base: PppoeServiceUpsert = {
      username: input.username,
      password: input.password,
      profile,
      remoteAddress,
      nasId: input.nasId,
      contractId: input.contractId ?? null,
      ipMode: 'fixed',
      ipTypePreference,
    };

    // 3. DB pending → aprovisionar (RADIUS o router según el NAS) → DB confirm
    await this.repo.upsertByUsername({ ...base, status: 'pending' });
    if (isRadius) {
      // `profile` está garantizado no-null por la guarda de arriba.
      await this.orchestrator.createUser({
        username: input.username,
        password: input.password,
        plan: profile!,
        framedIp,
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
    await this.activateInternet(input.contractId ?? null, actor);

    return result;
  }

  /** Guard #4 (pppoe-contract-integrity): el contrato no debe tener ya un PPPoE 'enabled'. */
  private async guardContractFree(contractId: string | null): Promise<void> {
    if (contractId == null) return;
    const existing = await this.repo.findByContract(contractId);
    const activeExisting = existing.find(p => p.status === 'enabled');
    if (activeExisting) {
      throw new PppoeContractAlreadyHasServiceError(contractId, activeExisting.id);
    }
  }

  /**
   * Post-alta best-effort: la línea INTERNET del contrato queda active.
   * fix-operador-alta: if ensureInternet no-ops (line already active), record 'activated'
   * event explicitly with actor so the operador is not empty.
   */
  private async activateInternet(
    contractId: string | null,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<void> {
    if (contractId == null) return;
    try {
      const opts = actor ? { actorId: actor.actorId ?? null, actorName: actor.actorName } : undefined;
      const recorded = await this.ensureInternet.execute(contractId, true, opts);
      if (!recorded && actor && this.catalogRepo && this.eventRepo) {
        // Line was already active (no-op): still record the 'activated' event with actor.
        try {
          const catalog = await this.catalogRepo.getByName('INTERNET');
          if (catalog) {
            await this.eventRepo.record({
              contractId,
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
}
