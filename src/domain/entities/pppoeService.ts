import type { IpKind } from './network';

/**
 * enforcedState (Fase C) — estado del CORTE de servicio, SEPARADO del `profile` comercial.
 * El `profile` de la DB siempre guarda el plan comercial; en el router puede estar cambiado a
 * `IP-REDUCCION` (reduce) o el secret `disabled` (block). Así `restore` devuelve el comercial.
 *   active   — sin corte (operando normal)
 *   reduced  — deudor: profile reducido en el router (IP-REDUCCION)
 *   blocked  — baja: secret deshabilitado en el router
 */
export type EnforcedState = 'active' | 'reduced' | 'blocked';

/** Acción de enforcement on-demand sobre un PPPoE. */
export type EnforcementAction = 'reduce' | 'block' | 'restore';

/** Estado destino (enforcedState) que deja cada acción. Conocimiento puro de dominio. */
export function enforcedStateForAction(action: EnforcementAction): EnforcedState {
  switch (action) {
    case 'reduce':  return 'reduced';
    case 'block':   return 'blocked';
    case 'restore': return 'active';
  }
}

/**
 * internet-history — estado de NEGOCIO de un PPPoE para la UI, computado del `status` crudo del
 * secret (RADIUS: enabled|disabled|terminated) + el `enforcedState` del corte (active|reduced|blocked).
 * El crudo no es presentable: 'enabled' con enforcedState 'reduced' es un DEUDOR, no "activo".
 * Conocimiento puro de dominio. Precedencia EXACTA (de arriba hacia abajo, el primero que matchea gana):
 *   1. status terminated                        → 'baja'
 *   2. status disabled OR enforcedState blocked → 'blocked'
 *   3. enforcedState reduced                    → 'reduced'
 *   4. status enabled AND enforcedState active  → 'active'
 *   5. default (defensivo)                      → 'inactive'
 */
export type PppoeDisplayStatus = 'active' | 'reduced' | 'blocked' | 'baja' | 'inactive';

export function pppoeDisplayStatus(status: string, enforcedState: EnforcedState): PppoeDisplayStatus {
  if (status === 'terminated') return 'baja';
  if (status === 'disabled' || enforcedState === 'blocked') return 'blocked';
  if (enforcedState === 'reduced') return 'reduced';
  if (status === 'enabled' && enforcedState === 'active') return 'active';
  return 'inactive';
}

/**
 * pppoe-bulk-select-filter (v2) — helper COMPARTIDO de normalización de filtro. El `status`
 * de un filtro de listado llega en vocabulario de NEGOCIO (string suelto, potencialmente
 * inválido); este type-guard valida contra los `PppoeDisplayStatus` conocidos. Fail-open:
 * un valor desconocido devuelve `false` (el caller lo trata como "sin filtro"), NUNCA lanza.
 *
 * ÚNICA fuente de verdad — usada por `ListAllPppoeServices` Y `ListAllPppoeServiceIds` para
 * que la traducción `status` → `displayStatus` NUNCA driftee entre el listado y el endpoint
 * de ids (guardrail doble del riesgo #1, junto con `buildListAllWhere` en el adapter Prisma).
 * Vivía duplicada como función privada en `ListAllPppoeServices.ts` antes de esta extracción.
 */
const PPPOE_DISPLAY_STATUSES: readonly PppoeDisplayStatus[] = ['active', 'reduced', 'blocked', 'baja', 'inactive'];

export function isPppoeDisplayStatus(v: string | undefined): v is PppoeDisplayStatus {
  return v !== undefined && (PPPOE_DISPLAY_STATUSES as readonly string[]).includes(v);
}

/**
 * pppoe-tie-break (finance-growth fix-wave-2) — deterministic winner when a
 * CONTRACT has more than one `PppoeService` row (multi-servicio, or a stale
 * row left behind after a re-provision that created a new username instead
 * of reusing the old one). Pure domain logic, SHARED verbatim by
 * `PrismaPppoeServiceRepository.findCurrentProfilesByContractIds` and
 * `InMemoryPppoeServiceRepository.findCurrentProfilesByContractIds` — a
 * change here updates the tie-break for BOTH adapters at once, closing the
 * exact class of bug this change already hit once (see design.md): the
 * in-memory adapter silently drifting from a DIFFERENT criterion than the
 * Prisma one, so a test wired against the fixture self-confirms a bug that
 * never actually holds against the real DB.
 *
 * Order (first match wins): non-`'terminated'` beats `'terminated'` (a hard
 * baja row is a tombstone, not a live service, but it is still a BETTER
 * signal than nothing — it's used only when it is the ONLY row) > `'enabled'`
 * beats any other status (e.g. `'disabled'`) > most recently created row wins
 * ties (a re-provision after a hardware swap creates a NEW row; the newest
 * one is the one actually in service today).
 *
 * Returns `undefined` when `rows` is empty — the caller treats this exactly
 * like "no PPPoE service at all" (finance-growth fix-wave-2 point 3): the
 * contract stays honestly `unpriced`, never a silent price of 0.
 *
 * fix-wave-3 (🟡 3) — generic over `T extends Pick<PppoeService, 'status' |
 * 'createdAt' | 'id'>` so a caller that only needs the WINNER's identity
 * (e.g. `PrismaPppoeServiceRepository.findCurrentProfilesByContractIds`,
 * which must NEVER read `password` into memory — see its own docblock) can
 * pass a narrow Prisma `select` projection instead of a full `PppoeService`,
 * while `InMemoryPppoeServiceRepository` keeps passing full entities from its
 * store unchanged (both satisfy the constraint).
 *
 * ALSO fix-wave-3 — added a FINAL tiebreak by `id` when both rank AND
 * `createdAt` are exactly equal (e.g. rows inserted by the same bulk-import
 * script in the same millisecond). Without it, `Array.prototype.sort`'s
 * ES2019 stability guarantee means a genuine tie resolves by the INPUT
 * array's order — which, for `PrismaPppoeServiceRepository` (no `ORDER BY`
 * before this fix), is Postgres's heap-scan order: NOT guaranteed stable
 * across runs, and observed to reshuffle after an `UPDATE`/`VACUUM`.
 * Measured: identical rows, different fetch order → the SAME month's MRR
 * computed as 10000 in one run and 15000 in the next. `id` carries no
 * business meaning here; it's used ONLY because it's the one field
 * guaranteed both unique and stable, giving every caller the exact same
 * total order regardless of where the rows came from.
 */
export function pickCurrentPppoeService<T extends Pick<PppoeService, 'status' | 'createdAt' | 'id'>>(rows: T[]): T | undefined {
  if (rows.length === 0) return undefined;
  const rank = (s: Pick<PppoeService, 'status'>): number => {
    if (s.status === 'terminated') return 2;
    if (s.status !== 'enabled') return 1;
    return 0;
  };
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

export interface PppoeService {
  id: string;
  username: string;            // name del /ppp secret — clave de upsert
  password: string;            // verdad técnica del router
  profile: string | null;     // /ppp profile COMERCIAL (IP-Air-* / *-PUB) — NO se pisa al cortar
  remoteAddress: string | null; // IP fija (remote-address): CGNAT o pública
  status: string;             // enabled | disabled (del secret) | terminated (baja HARD: user borrado del RADIUS, IP liberada)
  /**
   * pppoe-preprovision (D1): router donde vive (FK NasServer) — o NULL = PRE-PROVISIÓN
   * "pendiente de instalación": el usuario existe en el RADIUS central SIN Framed-IP y el
   * watcher lo adopta cuando aparece su primera sesión. "Pendiente" es esta DERIVACIÓN
   * (nasId === null), NO un status nuevo.
   */
  nasId: string | null;
  contractId: string | null; // FK Contract — null = sin contrato asociado aún
  enforcedState: EnforcedState; // Fase C: estado del corte (default 'active')
  callerId: string | null;    // MAC del CPE (persistida de la última sesión vista — sobrevive a la desconexión)
  /**
   * pppoe-pool-ip: modo de asignación de IP.
   * 'pool'  = FreeRADIUS asigna la IP del pool del NAS (framedIp null en RADIUS).
   * 'fixed' = IP pineada (radreply Framed-IP-Address) — bypasea el pool. Default 'fixed'.
   */
  ipMode: 'pool' | 'fixed';
  /**
   * pppoe-preprovision (D2): tipo de IP elegido al crear — 'cgnat' | 'public' (IpKind).
   * Obligatorio en el CREATE (zod 422); persistido para que la adopción (manual o del watcher)
   * asigne del pool correcto. Las filas legacy quedan 'cgnat' salvo backfill de públicas.
   */
  ipTypePreference: IpKind;
  createdAt: string;
}
