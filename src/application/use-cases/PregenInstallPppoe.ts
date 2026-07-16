import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { generatePppoeCredentials } from '@domain/services/pppoeCredentials';
import {
  PppoeUsernameTakenError,
  PppoeContractAlreadyHasServiceError,
  OrchestratorRejectedError,
} from '@domain/errors/pppoe';
import { CreatePppoeService } from './CreatePppoeService';

export interface PregenInstallPppoeInput {
  /** Local Contract id (FK real del espejo). */
  contractId: string;
  /** Número de contrato GR — la base determinística del username/password. */
  grContratoId: string;
  /** GR client id — para consultar el `pppoeUsername` histórico (best-effort). */
  grClienteId: string | null;
  /** `Client.name` espejado de GR ("APELLIDO(S) NOMBRE(S)"). */
  clientName: string;
  /** Grupo/plan RADIUS (radusergroup) configurado para la pre-provisión. */
  profile: string;
}

/**
 * Por qué el PPPoE encontrado NO es utilizable tal cual (fix HIGH del review):
 *  - 'disabled'      → baja soft: el username sobrevive pero el usuario está
 *                      suspendido/ausente del RADIUS. Sus credenciales NO autentican.
 *  - 'pending'       → un aprovisionamiento previo nunca llegó al RADIUS
 *                      (pregen/alta fallida). Sus credenciales NO autentican.
 *  - 'radius-desync' → el usuario VIVE en el RADIUS central pero el espejo no lo
 *                      conocía (409 al crear). Autentica, pero con una clave que
 *                      NO conocemos — verificar manualmente.
 */
export type PregenStaleReason = 'disabled' | 'pending' | 'radius-desync';

export type PregenInstallPppoeOutcome =
  | { status: 'created'; username: string; password: string }
  | { status: 'existing'; username: string }
  | { status: 'stale'; username: string; reason: PregenStaleReason }
  | { status: 'failed' };

/** Header del bloque de credenciales en la descripción de la tarea (K1). */
const BLOCK_HEADER = '── Credenciales PPPoE ──';

const STALE_WARNINGS: Record<PregenStaleReason, string> = {
  disabled:
    '⚠ Usuario previo dado de BAJA (estado disabled) — REVISAR en la página PPPoE antes de instalar',
  pending:
    '⚠ Aprovisionamiento previo PENDIENTE (no llegó al RADIUS) — reintentar desde la página PPPoE',
  'radius-desync':
    '⚠ El usuario ya existe en el RADIUS central — verificar credenciales manualmente',
};

/**
 * Bloque de texto que el ingest appendea a la descripción de la tarea de
 * instalación. El usuario pidió EXPLÍCITAMENTE las credenciales en texto en la
 * tarea (el instalador las carga en la ONT/antena) — no es un leak accidental.
 *
 * REGLA DURA (fix HIGH): el bloque JAMÁS presenta como listas credenciales que
 * no estén `enabled` + aprovisionadas:
 *  - `existing` (solo filas enabled) → username "(ya existente)", nunca la clave.
 *  - `stale` → advertencia explícita por motivo (baja / pendiente / desync),
 *    nunca "(ya existente)" ni la clave — el técnico NO debe ir a campo con eso.
 *  - `failed` → sin bloque (no hay credenciales reales que mostrar).
 */
export function renderPppoeCredentialsBlock(outcome: PregenInstallPppoeOutcome): string | null {
  if (outcome.status === 'created') {
    return (
      `${BLOCK_HEADER}\n` +
      `Usuario: ${outcome.username}\n` +
      `Clave: ${outcome.password}\n` +
      `Estado: pendiente de instalar`
    );
  }
  if (outcome.status === 'existing') {
    return `${BLOCK_HEADER}\nUsuario: ${outcome.username} (ya existente)`;
  }
  if (outcome.status === 'stale') {
    return `${BLOCK_HEADER}\nUsuario: ${outcome.username}\n${STALE_WARNINGS[outcome.reason]}`;
  }
  return null;
}

/**
 * install-pppoe-pregen (K1) — asegura un PPPoE PRE-PROVISIONADO ("pendiente de
 * instalación" = `nasId null`, feature pppoe-preprovision D3) para el contrato
 * de una instalación ingestada desde Gestión Real.
 *
 * Flujo:
 *  1. Contrato con PPPoE `enabled` → NO duplica: outcome `existing` (username
 *     sin clave). Contrato con PPPoE `pending` → `stale/pending`: ese
 *     aprovisionamiento nunca llegó al RADIUS, NO son credenciales utilizables.
 *  2. Genera credenciales determinísticas (`generatePppoeCredentials`:
 *     nombre+apellido+contrato / nombre+1234).
 *  3. Si GR trae `pppoeUsername` histórico para el contrato, GANA el de GR —
 *     es el username REAL del cliente en el RADIUS legado y preservarlo evita
 *     un rename post-instalación. Consulta best-effort: si GR no responde, se
 *     cae al generado (jamás bloquea el ingest).
 *  4. Crea vía `CreatePppoeService` con `nasId: null` → usuario en el RADIUS
 *     central SIN Framed-IP; el watcher lo adopta al conectar por primera vez.
 *
 * Degradaciones (nunca throw — un fallo acá no puede sinkear el batch del ingest):
 *  - Username tomado por otra fila → según el status de esa fila: `enabled` →
 *    `existing`; `pending` → `stale/pending`; `disabled`/`terminated` (baja
 *    soft que conserva el username — reinstalación típica) → `stale/disabled`.
 *  - 409 del orchestrator (usuario vivo en el RADIUS central, ausente del
 *    espejo) → `stale/radius-desync` y se BORRA la fila espejo recién creada:
 *    su password generada NO es la real del RADIUS y envenenaría cualquier
 *    retry/changePassword posterior (fix MEDIUM del review).
 *  - Carrera "contrato ya tiene PPPoE" (guard #4 de CreatePppoeService) →
 *    re-lee y resuelve por status como en (1).
 *  - Aprovisionamiento caído (orchestrator unreachable) → `failed` (la fila
 *    queda `pending`, visible y reintentable — ahí la password generada SÍ es
 *    legítima: el usuario aún no existe en el RADIUS; la tarea se crea igual,
 *    sin bloque de credenciales).
 */
export class PregenInstallPppoe {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly createPppoe: CreatePppoeService,
    private readonly gr: GestionRealPort,
  ) {}

  async execute(input: PregenInstallPppoeInput): Promise<PregenInstallPppoeOutcome> {
    // 1. ¿El contrato ya tiene un PPPoE vivo? enabled = utilizable ("ya existente");
    //    pending = pre-provisión a medio confirmar → stale (credenciales muertas).
    const alive = await this.resolveContractOutcome(input.contractId);
    if (alive) return alive;

    // 2. Credenciales determinísticas (mismo input → mismo output; re-ingest idempotente).
    const generated = generatePppoeCredentials(input.clientName, input.grContratoId);

    // 3. El username histórico de GR gana si existe (best-effort).
    const username = (await this.resolveGrUsername(input)) ?? generated.username;

    // 4. Pre-provisión real: RADIUS central sin Framed-IP + fila espejo nasId null.
    try {
      await this.createPppoe.execute({
        contractId: input.contractId,
        username,
        password: generated.password,
        profile: input.profile,
        nasId: null,
      });
      return { status: 'created', username, password: generated.password };
    } catch (err) {
      return this.degrade(err, username, input);
    }
  }

  /** Mapea los errores de la creación a un outcome honesto (nunca re-throw). */
  private async degrade(
    err: unknown,
    username: string,
    input: PregenInstallPppoeInput,
  ): Promise<PregenInstallPppoeOutcome> {
    if (err instanceof PppoeUsernameTakenError) {
      // Existe una fila con ese nombre. SOLO una fila enabled es presentable como
      // "(ya existente)": disabled/terminated = baja (credenciales muertas),
      // pending = nunca aprovisionado. Jamás mandar al técnico a campo con eso
      // (fix HIGH). Fila desaparecida entre el throw y la re-lectura (carrera
      // ultra rara) → degradar al comportamiento previo ('existing').
      const row = await this.pppoeRepo.findByUsername(username);
      if (!row || row.status === 'enabled') return { status: 'existing', username };
      if (row.status === 'pending') return { status: 'stale', username, reason: 'pending' };
      return { status: 'stale', username, reason: 'disabled' };
    }
    if (err instanceof OrchestratorRejectedError && err.upstreamStatus === 409) {
      // El usuario VIVE en el RADIUS central pero el espejo no lo conocía. La fila
      // pending recién upserteada carga una password INVENTADA (≠ la real del
      // RADIUS): borrarla para que ningún flujo posterior confíe en esa clave.
      await this.cleanupPoisonedRow(username, input.contractId);
      return { status: 'stale', username, reason: 'radius-desync' };
    }
    if (err instanceof PppoeContractAlreadyHasServiceError) {
      // Carrera: alguien creó el PPPoE del contrato entre el check y el create.
      const winner = await this.resolveContractOutcome(input.contractId);
      if (winner) return winner;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[gr-ingest] pre-provisión PPPoE falló para contrato ${input.grContratoId} (${username}):`,
      err,
    );
    return { status: 'failed' };
  }

  /**
   * Outcome derivado del PPPoE ya asociado al contrato, o null si no hay ninguno
   * vivo (las filas disabled/terminated NO bloquean una re-alta: si su username
   * colisiona, el caso se resuelve en el path UsernameTaken).
   */
  private async resolveContractOutcome(
    contractId: string,
  ): Promise<PregenInstallPppoeOutcome | null> {
    const rows = await this.pppoeRepo.findByContract(contractId);
    const enabled = rows.find(p => p.status === 'enabled');
    if (enabled) return { status: 'existing', username: enabled.username };
    const pending = rows.find(p => p.status === 'pending');
    if (pending) return { status: 'stale', username: pending.username, reason: 'pending' };
    return null;
  }

  /**
   * Borra la fila espejo `pending` que ESTE flujo acaba de upsertear (guard por
   * status+contractId: si el 409 llegó, el dup-check local pasó — la fila es
   * nuestra). El username sigue vivo en el RADIUS; el inventario puede
   * re-adoptarlo con su password REAL.
   */
  private async cleanupPoisonedRow(username: string, contractId: string): Promise<void> {
    try {
      const row = await this.pppoeRepo.findByUsername(username);
      if (row && row.status === 'pending' && row.contractId === contractId) {
        await this.pppoeRepo.deleteById(row.id);
      }
    } catch (cleanupErr) {
      // eslint-disable-next-line no-console
      console.error(`[gr-ingest] cleanup de fila pending envenenada falló (${username}):`, cleanupErr);
    }
  }

  /** `pppoeUsername` histórico del contrato en GR (trim, no-vacío), o null. Best-effort. */
  private async resolveGrUsername(input: PregenInstallPppoeInput): Promise<string | null> {
    if (!input.grClienteId) return null;
    try {
      const contracts = await this.gr.fetchContractsByClient(input.grClienteId);
      const match = contracts.find(c => c.grContratoId === input.grContratoId);
      const historic = match?.pppoeUsername?.trim();
      return historic ? historic : null;
    } catch {
      return null; // GR caído no bloquea la pre-generación.
    }
  }
}
