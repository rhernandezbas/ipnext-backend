import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { generatePppoeCredentials } from '@domain/services/pppoeCredentials';
import {
  PppoeUsernameTakenError,
  PppoeContractAlreadyHasServiceError,
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

export type PregenInstallPppoeOutcome =
  | { status: 'created'; username: string; password: string }
  | { status: 'existing'; username: string }
  | { status: 'failed' };

/** Header del bloque de credenciales en la descripción de la tarea (K1). */
const BLOCK_HEADER = '── Credenciales PPPoE ──';

/**
 * Bloque de texto que el ingest appendea a la descripción de la tarea de
 * instalación. El usuario pidió EXPLÍCITAMENTE las credenciales en texto en la
 * tarea (el instalador las carga en la ONT/antena) — no es un leak accidental.
 * `existing` NUNCA lleva la clave (no la conocemos y no debe reimprimirse);
 * `failed` no produce bloque (no hay credenciales reales que mostrar).
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
  return null;
}

/**
 * install-pppoe-pregen (K1) — asegura un PPPoE PRE-PROVISIONADO ("pendiente de
 * instalación" = `nasId null`, feature pppoe-preprovision D3) para el contrato
 * de una instalación ingestada desde Gestión Real.
 *
 * Flujo:
 *  1. Contrato con PPPoE vivo (status `enabled` o `pending`) → NO duplica:
 *     outcome `existing` con el username (la descripción de la tarea lo lleva
 *     sin la clave).
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
 *  - Username ya tomado por OTRA fila (p.ej. huérfano adoptado del inventario
 *    RADIUS con ese mismo nombre) → `existing` con ese username.
 *  - Carrera "contrato ya tiene PPPoE" (guard #4 de CreatePppoeService) →
 *    re-lee y devuelve `existing`.
 *  - Aprovisionamiento caído (orchestrator) → `failed` (la fila queda `pending`,
 *    visible y reintentable desde la página de PPPoE; la tarea se crea igual,
 *    sin bloque de credenciales).
 */
export class PregenInstallPppoe {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly createPppoe: CreatePppoeService,
    private readonly gr: GestionRealPort,
  ) {}

  async execute(input: PregenInstallPppoeInput): Promise<PregenInstallPppoeOutcome> {
    // 1. ¿El contrato ya tiene un PPPoE vivo? (enabled o pending — un pending es
    //    una pre-provisión a medio confirmar, crear otro sería duplicar).
    const existing = await this.findAlive(input.contractId);
    if (existing) return { status: 'existing', username: existing };

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
      if (err instanceof PppoeUsernameTakenError) {
        // Existe en el sistema con ese nombre (huérfano/otro contrato): usarlo como
        // referencia en la tarea, sin pisar nada y sin inventar una variante.
        return { status: 'existing', username };
      }
      if (err instanceof PppoeContractAlreadyHasServiceError) {
        // Carrera: alguien creó el PPPoE del contrato entre el check y el create.
        const winner = await this.findAlive(input.contractId);
        if (winner) return { status: 'existing', username: winner };
      }
      // eslint-disable-next-line no-console
      console.error(
        `[gr-ingest] pre-provisión PPPoE falló para contrato ${input.grContratoId} (${username}):`,
        err,
      );
      return { status: 'failed' };
    }
  }

  /** Username del PPPoE vivo (enabled/pending) del contrato, o null. */
  private async findAlive(contractId: string): Promise<string | null> {
    const rows = await this.pppoeRepo.findByContract(contractId);
    const alive = rows.find(p => p.status === 'enabled' || p.status === 'pending');
    return alive?.username ?? null;
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
