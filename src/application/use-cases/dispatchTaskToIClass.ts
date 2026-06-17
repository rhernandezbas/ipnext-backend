/**
 * dispatchTaskToIClass — helper compartido de orquestacion (AD-3).
 *
 * Encapsula: validar required fields + resolver nodo + createServiceOrder +
 * setIClassOrderCode + avanzar a registered_in_iclass.
 *
 * Reusado por SendTaskToIClass y ResendTaskToIClassWithNode.
 * Funcion pura sobre ports — NUNCA importa nada de @infrastructure/*.
 *
 * Traza: REQ-RESEND-8, REQ-AUDIT-5, REQ-AUDIT-6.
 * network-node-task (#29): sustitucion de campos para tareas de RED.
 */
import { ScheduledTask } from '@domain/entities/scheduling';
import { NetworkSite } from '@domain/entities/networkSite';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassDispatchAttemptRepository } from '@domain/ports/IClassDispatchAttemptRepository';
import { RecordDispatchAttemptInput } from '@domain/entities/iclass-dispatch-attempt';
import {
  StageNotFoundError,
  TaskNotFoundError,
  MissingRequiredFieldsError,
} from '@domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassRejectedError,
  IClassUnavailableError,
} from '@domain/errors/iclass';

/** Constantes para tareas de RED (network-node-task #29). */
export const NETWORK_PHONE          = '0000000000';
export const NETWORK_CUSTOMER_CODE  = 'NETWORK';

/** '' / whitespace / null / undefined cuentan como blank. */
function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

/** Primer valor NO-blank ('' cuenta como blank — NetworkSite.address es string, nunca null). */
function firstNonBlank(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) if (!isBlank(v)) return v!;
  return null;
}

/** Immutable business code for the "Registrado en IClass" stage. */
const REGISTERED_IN_ICLASS_CODE = 'registered_in_iclass';

export interface DispatchDeps {
  tasks: SchedulingRepository;
  iclass: IClassPort;
  /** Opcional. Best-effort — si no se provee, no se registran attempts. */
  attempts?: IClassDispatchAttemptRepository;
}

export interface DispatchOpts {
  /** Override de nodo (reenvio manual). Si viene, salta el uso de city como nodeCode. */
  nodeCodeOverride?: string;
  /** Actor para el audit. */
  actorId?: string | null;
  /** workflowId del stage destino, para resolver registered_in_iclass scoped. */
  workflowId: string;
  /**
   * network-node-task (#29): sitio de red asociado a la tarea.
   * Cuando viene, se usan sus campos en lugar de los del cliente.
   */
  networkSite?: NetworkSite | null;
}

/**
 * Helper no-fatal (AD-6): registra un attempt de dispatch.
 * Si el repo falla, loguea y NO propaga. El error de dominio original se re-lanza
 * por el caller DESPUES de llamar a recordAttempt.
 */
export async function recordAttempt(
  attempts: IClassDispatchAttemptRepository | undefined,
  input: RecordDispatchAttemptInput,
): Promise<void> {
  if (!attempts) return;
  try {
    await attempts.record(input);
  } catch (e) {
    // best-effort: el audit NUNCA tumba el envio/reenvio (AD-6)
    console.error('[iclass-dispatch-audit] failed to record attempt', e);
  }
}

/**
 * Mapea un error capturado al IClassDispatchOutcome correspondiente.
 */
function errorToOutcome(
  err: unknown,
): 'node_not_found' | 'rejected' | 'unavailable' | 'error' {
  if (err instanceof IClassNodeNotFoundError) return 'node_not_found';
  if (err instanceof IClassRejectedError) return 'rejected';
  if (err instanceof IClassUnavailableError) return 'unavailable';
  return 'error';
}

function errorCode(err: unknown): string {
  if (err instanceof IClassNodeNotFoundError) return 'ICLASS_NODE_NOT_FOUND';
  if (err instanceof IClassRejectedError) return 'ICLASS_REJECTED';
  if (err instanceof IClassUnavailableError) return 'ICLASS_UNAVAILABLE';
  return 'ICLASS_ERROR';
}

/**
 * Orquesta la creacion de la OS en IClass y el avance de stage.
 *
 * Pre-condicion: el caller ya valido required fields y resolvio el nodo correcto
 * (pasado como nodeCode). El caller ya tiene el soTypeCode.
 *
 * Post-condicion (exito): tarea con iclassOrderCode asignado, en stage registered_in_iclass.
 * Post-condicion (fallo): se registra attempt (best-effort) y se re-lanza el error.
 */
export async function dispatchToIClass(
  deps: DispatchDeps,
  task: ScheduledTask,
  soTypeCode: string,
  nodeCode: string,
  opts: DispatchOpts,
): Promise<ScheduledTask> {
  const { tasks, iclass, attempts } = deps;
  const { actorId, workflowId, networkSite } = opts;

  // network-node-task (#29): sustitucion de campos para tareas de RED/FIBRA.
  const isNet = task.kind === 'network';
  // #66 — fibra branch: networkType === 'fibra' uses locality + free-text node name only.
  const isFibra = isNet && task.networkType === 'fibra';

  // #121 (revisa #55) — modelo cliente=customer / contrato=dirección:
  //   - customerCode (IClass) = el CLIENTE  → task.customerCode (CUSTOMER tasks).
  //   - addressCode  (IClass) = el CONTRATO → firstNonBlank(task.contractCode, task.customerCode),
  //     ESTABLE: agrupa N OS del mismo contrato bajo UNA dirección (nunca el soCode único).
  // NETWORK path: red usa site.iclassNodeCode; fibra usa iclassCityCode — ambos como
  // customerCode Y como addressCode (el código de nodo/ciudad es estable y agrupa las
  // OS del nodo en una sola dirección).
  const effectiveCustomerCode = isNet
    ? (isFibra
        ? (task.iclassCityCode ?? NETWORK_CUSTOMER_CODE)
        : (networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE))
    : task.customerCode!;
  // addressCode estable: contrato (fallback cliente) en CUSTOMER; mismo código de
  // nodo/ciudad (= customerCode) en NETWORK. NUNCA el soCode (sequenceNumber, único por OS).
  const effectiveAddressCode = isNet
    ? effectiveCustomerCode
    : (firstNonBlank(task.contractCode, task.customerCode) ?? task.customerCode!);
  // fibra: node name; red: site name (JOIN-derived).
  const effectiveCustomerName = isNet ? (task.networkSiteName ?? '') : task.customerName!;
  const effectivePhone        = isNet ? NETWORK_PHONE             : task.customerPhone!;
  // fibra: task.address (req'd) or free-text name; red (#53 fix): site.address ?? task.address ?? site.name.
  const effectiveAddress      = isNet
    ? (isFibra
        ? (firstNonBlank(task.address, task.networkSiteName) ?? '')
        : (firstNonBlank(networkSite?.address, task.address, task.networkSiteName) ?? ''))
    : task.address!;
  // fibra: iclassCityCode is both city and nodeCode; red (#54): iclassCityCode ?? site.city.
  const effectiveCity         = isNet
    ? (isFibra
        ? (task.iclassCityCode ?? '')
        : (firstNonBlank(task.iclassCityCode, networkSite?.city) ?? ''))
    : task.customerCity!;

  try {
    // #121 WARNING #1 — guard: para tareas de CLIENTE, customerCode (= cliente) y
    // addressCode (= contrato, fallback cliente) DERIVAN de task.customerCode/contractCode.
    // Si AMBOS son null/blank, los `!` de arriba serian null en runtime y mandariamos
    // null a IClass → rechazo silencioso (ICLERR). Fallamos explicito ANTES de la llamada.
    // El catch de abajo registra el attempt (best-effort, AD-6) como cualquier otro fallo.
    // NETWORK path nunca cae aca: siempre tiene `?? NETWORK_CUSTOMER_CODE`.
    if (!isNet && isBlank(effectiveCustomerCode) && isBlank(effectiveAddressCode)) {
      throw new MissingRequiredFieldsError(['customerCode', 'contractCode']);
    }

    const { orderCode } = await iclass.createServiceOrder({
      soCode: String(task.sequenceNumber),
      customerCode: effectiveCustomerCode,
      addressCode: effectiveAddressCode,
      customerName: effectiveCustomerName,
      phone: effectivePhone,
      address: effectiveAddress,
      city: effectiveCity,
      description: task.description!,
      soType: soTypeCode,
      nodeCode,
    });

    // Persist orderCode
    await tasks.setIClassOrderCode(task.id, orderCode);

    // Advance to registered_in_iclass
    const registeredStage = await tasks.getStageByCode(REGISTERED_IN_ICLASS_CODE, workflowId);
    if (!registeredStage) throw new StageNotFoundError(REGISTERED_IN_ICLASS_CODE);

    const moved = await tasks.moveTaskToStage(task.id, registeredStage.id);
    if (!moved) throw new TaskNotFoundError(task.id);

    return moved;
  } catch (err) {
    // Record attempt (best-effort, non-fatal — AD-6)
    await recordAttempt(attempts, {
      taskId: task.id,
      outcome: errorToOutcome(err),
      errorCode: errorCode(err),
      errorMessage: err instanceof Error ? err.message : String(err),
      attemptedNodeCode: nodeCode,
      resolvedNodeCode: null,
      actorId: actorId ?? null,
    });
    throw err;
  }
}
