/**
 * RenamePppoeUsername — pppoe-full-management (D4) + fix-wave (C1/W1/W2) + fix-wave-2 (CRITICAL).
 *
 * Renombra un PPPoE usando el flujo seguro CREATE-then-DELETE:
 *
 *   1. Leer el PPPoE viejo por id (PppoeServiceNotFoundError si no existe).
 *   2. Cargar el NAS del PPPoE y validar que es `radius_orchestrator` — fix-wave-2:
 *        - NAS no encontrado            → NasNotFoundError
 *        - NAS no es radius_orchestrator → PppoeRenameNasNotSupportedError (422)
 *      El rename es un flujo SOLO-RADIUS: siempre usa orchestrator.createUser / deleteUser.
 *      Renombrar un PPPoE de un NAS MikroTik vía orchestrator crearía un fantasma en el
 *      RADIUS + espejo inconsistente → no soportado.
 *   3. Verificar que old.profile no sea null/vacío (PppoeProfileRequiredError) — W2.
 *   4. Verificar unicidad del newUsername en el espejo (PppoeUsernameTakenError si ya existe).
 *   5. orchestrator.createUser(newUsername, old.password, old.profile, old.remoteAddress).
 *      - Si el orchestrator responde 409 → PppoeUsernameTakenError (no OrchestratorRejectedError) — W1.
 *   6. Re-aplicar el enforcement del viejo sobre el nuevo username — C1:
 *      - enforcedState='blocked' → enforcement.apply('block', realNas)
 *      - enforcedState='reduced' → enforcement.apply('reduce', realNas)
 *      - status='disabled'       → orchestrator.suspend (best-effort, legacy path)
 *      Si apply falla (blocked/reduced) → intentar limpiar el nuevo en RADIUS y propagar error.
 *   7. orchestrator.deleteUser(oldUsername).
 *      - Si falla paso 7 → return { status: 'partial', message } SIN actualizar espejo
 *        (el viejo sobrevive; operador debe reconciliar manualmente).
 *   8. pppoeRepo.updateUsername(id, newUsername)  ← MISMO row: preserva id, contractId, callerId, historial.
 *   9. return { status: 'ok', id, username: newUsername }.
 *
 * NUNCA delete-first: si createUser falla, el viejo queda intacto.
 *
 * Errores tipados:
 *   - PppoeServiceNotFoundError        → 404
 *   - NasNotFoundError                 → 404  (nasId del PPPoE no existe en el repo)
 *   - PppoeRenameNasNotSupportedError  → 422  (NAS no es radius_orchestrator — fix-wave-2)
 *   - PppoeProfileRequiredError        → 422  (W2: profile nulo/vacío — RADIUS necesita plan)
 *   - PppoeUsernameTakenError          → 409  (espejo o orchestrator 409 — W1)
 *   - OrchestratorUnreachableError (en paso 5) → 502 (propagado, viejo intacto)
 *   - OrchestratorRejectedError (≠409 en paso 5) → upstream status (propagado)
 */
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import type { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import type { NasRepository } from '@domain/ports/NasRepository';
import type { NasServer } from '@domain/entities/nas';
import { routesViaOrchestrator } from '@domain/entities/nas';
import type { EnforcementAction } from '@domain/entities/pppoeService';
import {
  PppoeServiceNotFoundError,
  PppoeUsernameTakenError,
  PppoeProfileRequiredError,
  OrchestratorRejectedError,
  NasNotFoundError,
  PppoeRenameNasNotSupportedError,
  PppoePendingInstallError,
} from '@domain/errors/pppoe';
import type { RenamePppoeResultDto } from '@application/dto/pppoe.dto';

export interface RenamePppoeUsernameInput {
  id: string;
  newUsername: string;
}

export class RenamePppoeUsername {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    /**
     * fix-wave-2 (CRITICAL): necesario para el guard de tipo de NAS (paso 2).
     * Se carga el NAS real del PPPoE para validar que es radius_orchestrator antes de
     * tocar el plano de control, y para pasarlo correctamente al enforcement.
     */
    private readonly nasRepo: NasRepository,
    /**
     * C1 fix: gateway de enforcement para re-aplicar corte/reducción sobre el nuevo username.
     * Debe ser el OrchestratorEnforcementAdapter (RADIUS directo), NO el PerNasEnforcementGateway.
     * Razón: tras el guard (paso 2), el PPPoE SIEMPRE está en un NAS radius_orchestrator.
     * El enforcement va siempre por RADIUS. Pasarle el PerNasEnforcementGateway con el NAS real
     * funcionaría (rutea a radiusEnforcement), pero usar el adapter RADIUS directamente es más
     * explícito y evita depender del ruteo interno del gateway compuesto.
     * Opcional para backward-compat con callers que no lo pasan (status=disabled path sigue
     * funcionando sin él). Cuando `enforcedState` es blocked/reduced y NO se provee, la
     * operación no se bloquea pero el enforcement NO se re-aplica — un caller correcto DEBE
     * proveerlo siempre que el PPPoE pueda estar bajo enforcement.
     */
    private readonly enforcement?: EnforcementGateway,
  ) {}

  async execute(input: RenamePppoeUsernameInput): Promise<RenamePppoeResultDto> {
    const { id, newUsername } = input;

    // 1. Leer el viejo.
    const old = await this.pppoeRepo.findById(id);
    if (!old) throw new PppoeServiceNotFoundError(id);

    const oldUsername = old.username;

    // Idempotencia: si el username ya es el destino, no hay nada que hacer.
    if (oldUsername === newUsername) {
      return { id, username: newUsername, status: 'ok' };
    }

    // 2. fix-wave-2 (CRITICAL) — Cargar y validar el NAS.
    //    El rename es un flujo SOLO-RADIUS: siempre usa orchestrator.createUser / deleteUser.
    //    Rechazar antes de tocar el plano de control para no crear fantasmas ni inconsistencias.
    //    pppoe-preprovision (REQ-PRE-4): un pendiente (nasId null) no se renombra hasta la adopción.
    if (old.nasId === null) throw new PppoePendingInstallError(old.id);
    const nas = await this.nasRepo.findNasServerById(old.nasId);
    if (!nas) throw new NasNotFoundError(old.nasId);
    if (!routesViaOrchestrator(nas.type)) {
      throw new PppoeRenameNasNotSupportedError(nas.type);
    }

    // 3. W2 — Validar que el viejo tenga profile (plan RADIUS). Sin plan no se puede crear
    //    el nuevo secret en el RADIUS → error early, antes de tocar nada.
    if (!old.profile) {
      throw new PppoeProfileRequiredError(newUsername);
    }

    // 4. Unicidad en el espejo.
    const existing = await this.pppoeRepo.findByUsername(newUsername);
    if (existing) throw new PppoeUsernameTakenError(newUsername);

    // 5. Crear el nuevo en el RADIUS.
    //    W1: si el orchestrator devuelve 409, el username está tomado en el RADIUS (pero no en
    //    el espejo) → mapear a PppoeUsernameTakenError para coherencia con el FE.
    try {
      await this.orchestrator.createUser({
        username:  newUsername,
        password:  old.password,
        plan:      old.profile,
        framedIp:  old.remoteAddress,
      });
    } catch (err) {
      if (err instanceof OrchestratorRejectedError && err.upstreamStatus === 409) {
        throw new PppoeUsernameTakenError(newUsername);
      }
      throw err; // OrchestratorUnreachableError o cualquier otro → propagar (viejo intacto)
    }

    // 6. C1 — Re-aplicar el enforcement del viejo sobre el nuevo username.
    //    El espejo preserva enforcedState en el MISMO row → tras updateUsername, el
    //    enforcedState correcto ya estará guardado. Lo que falta es aplicarlo en el RADIUS.
    //
    //    Casos:
    //    a) enforcedState='blocked' → suspender el nuevo (enforcement.apply 'block')
    //    b) enforcedState='reduced' → cambiar plan al de reducción (enforcement.apply 'reduce')
    //    c) status='disabled'       → suspender (legacy, best-effort como hoy)
    //    d) enforcedState='active'  → nada que hacer
    //
    //    Para (a) y (b): si el enforcement falla → intentar limpiar el nuevo en RADIUS y
    //    propagar el error. Un cliente que debía estar cortado y quedó activo es peor que
    //    un error visible (ver spec: "no tragues en silencio").
    //
    //    El NAS real (cargado en paso 2) se pasa al apply. El enforcement inyectado en prod
    //    es OrchestratorEnforcementAdapter (ignora el NAS, usa solo pppoe.username), pero
    //    pasarlo explícitamente es correcto y permite usar el PerNasEnforcementGateway si
    //    alguna vez se migra el rename a otros tipos de NAS.
    if ((old.enforcedState === 'blocked' || old.enforcedState === 'reduced') && this.enforcement) {
      const action: EnforcementAction = old.enforcedState === 'blocked' ? 'block' : 'reduce';
      // Entidad sintética con el nuevo username para que el adapter aplique al usuario correcto.
      const synthetic = { ...old, username: newUsername };
      try {
        await this.enforcement.apply(synthetic, nas as NasServer, action);
      } catch (enforcementErr) {
        // Limpieza best-effort: borrar el nuevo que creamos (rollback parcial).
        try { await this.orchestrator.deleteUser(newUsername); } catch { /* ignorar cleanup error */ }
        throw enforcementErr; // propagar: error claro > cliente activo que debía estar cortado
      }
    } else if (old.status === 'disabled') {
      // Legacy: secret comercialmente dado de baja. Suspender en el RADIUS (best-effort).
      try {
        await this.orchestrator.suspend(newUsername);
      } catch {
        // best-effort: el nuevo ya está creado; si el suspend falla no revertimos.
        // En la práctica se reconcilia en el próximo ciclo de enforcement.
      }
    }

    // 7. Borrar el viejo en el RADIUS. Si falla → partial.
    try {
      await this.orchestrator.deleteUser(oldUsername);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Viejo sobrevive en el espejo — NO llamar updateUsername.
      return { id, username: newUsername, status: 'partial', message };
    }

    // 8. Actualizar el espejo (MISMO row: preserva id, contractId, callerId, enforcedState, etc.).
    await this.pppoeRepo.updateUsername(id, newUsername);

    return { id, username: newUsername, status: 'ok' };
  }
}
