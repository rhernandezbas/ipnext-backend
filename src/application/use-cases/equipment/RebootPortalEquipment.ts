import type { ResolveEquipmentRebootEligibility } from './ResolveEquipmentRebootEligibility';
import type { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import { EquipmentNotEligibleError } from '@domain/errors/equipment';
import { OltProvisioningError } from '@domain/errors/smartolt';

/** Logger mínimo inyectable (default: console) — molde `AttachmentLogger`. */
export interface RebootDispatchLogger {
  error(message: string, meta?: unknown): void;
}

/**
 * portal-equipment-reboot — `POST /api/portal/equipment/:contractId/reboot`.
 *
 * REGLA DURA (mismo criterio que `UpdatePortalWifiBand`, "el server las
 * re-verifica en cada escritura"): esta acción corre
 * `ResolveEquipmentRebootEligibility` COMPLETO de nuevo — NUNCA confía en un
 * estado leído en un GET anterior. Si la ONU dejó de ser elegible entre el GET
 * y el POST (p.ej. desapareció de SmartOLT) la acción se RECHAZA con
 * `EquipmentNotEligibleError`, jamás dispara un reinicio a ciegas. Esa
 * verificación sigue siendo SÍNCRONA: es la que decide 409 vs 404 vs seguir, y
 * no puede volverse invisible.
 *
 * ASINCRÓNICO desde el bug reportado en vivo (cliente reinició desde la app:
 * 1er intento "Ocurrió un error", 2do funcionó, CERO líneas en los logs de
 * prod). El cliente esperaba parado en la pantalla de confirmación por: el
 * round-trip de elegibilidad a SmartOLT (8.3s medidos en frío) + el POST del
 * reboot + la pausa anti-burst (`stepPauseMs`, 2000ms) — con 15s de timeout por
 * llamada. Cualquier fallo de SmartOLT terminaba en 500 y el mensaje rojo
 * genérico.
 *
 * Ahora: confirmada la elegibilidad, el `gateway.reboot(sn)` se dispara
 * DESACOPLADO y `execute()` resuelve enseguida — la ruta contesta 202 y el
 * resultado del reboot ya NO afecta la respuesta HTTP. 202 = ACEPTADO, no =
 * completado: el cliente no tiene forma de enterarse por esta respuesta si el
 * reinicio realmente ocurrió (lo ve porque el equipo se reinicia, o reintenta).
 *
 * Dos cosas que NO son opcionales en el disparo desacoplado:
 *  - el `.catch()`: una unhandled rejection en Node puede voltear el proceso
 *    (mismo criterio que `FireAndForgetChatMediaDownloadTrigger`);
 *  - el LOG del fallo: es la mitad del valor de este cambio. Sin él volvemos a
 *    la ceguera que impidió diagnosticar el reporte original.
 */
export class RebootPortalEquipment {
  constructor(
    private readonly resolveEligibility: ResolveEquipmentRebootEligibility,
    private readonly gateway: Pick<OltProvisioningGateway, 'reboot'>,
    private readonly logger: RebootDispatchLogger = console,
  ) {}

  async execute(clientId: string, contractId: string): Promise<void> {
    const result = await this.resolveEligibility.execute(clientId, contractId);
    if (!result.eligible) {
      throw new EquipmentNotEligibleError(result.reason);
    }

    this.dispatchReboot(contractId, result.sn);
  }

  /**
   * Dispara el reinicio DESACOPLADO de la respuesta HTTP. Sincrónico a
   * propósito (no devuelve promesa): así ningún caller puede "arreglarlo"
   * poniéndole un `await` y reintroducir la espera que este cambio saca.
   *
   * El `Promise.resolve().then(...)` NO es adorno: si un adapter tirara
   * SINCRÓNICAMENTE (un throw antes del primer await, p.ej. validando la sn) un
   * `gateway.reboot(sn).catch(...)` pelado no lo atajaría y el error volvería a
   * salir por el 500. Envuelto, TODO fallo del disparo — sync o async — cae en
   * el mismo `.catch`.
   */
  private dispatchReboot(contractId: string, sn: string): void {
    void Promise.resolve()
      .then(() => this.gateway.reboot(sn))
      .catch((err: unknown) => {
        this.logger.error('[portal-equipment-reboot] el reinicio desacoplado FALLÓ en SmartOLT', {
          contractId,
          sn,
          // `reason` es lo único que distingue "SmartOLT no configurado" de
          // "timeout" de "la OLT rechazó" — el dato que faltaba para
          // diagnosticar el reporte original.
          reason: err instanceof OltProvisioningError ? err.reason : undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
