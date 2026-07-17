/**
 * K3 (fiber-auto-watcher) — registro PERSISTIDO de intentos de auto-aprovisionamiento
 * por (taskId, onuSn). Anti-reintento infinito: sobrevive restarts (tabla
 * FiberAutoProvisionAttempt), máximo 3 intentos con backoff, estados terminales
 * no se reintentan jamás.
 */

export type FiberAutoProvisionAttemptStatus =
  /** Reintentable tras el backoff (fallo transitorio). */
  | 'pending'
  /** Aprovisionada por el watcher — nunca re-aprovisionar aunque SmartOLT la siga listando. */
  | 'succeeded'
  /** 3 fallos — nota en la tarea, no insistir más (el humano usa el botón). */
  | 'failed-final'
  /** VLAN manual (CHIVILCOY) u ONU no-Huawei — nunca auto, sin reintentos. */
  | 'manual-required'
  /** Serial duplicado en 2+ tareas — se REANUDA solo si vuelve a ser único. */
  | 'conflict';

export interface FiberAutoProvisionAttempt {
  taskId: string;
  /** SN canónico (UPPERCASE sin espacios). */
  onuSn: string;
  attempts: number;
  status: FiberAutoProvisionAttemptStatus;
  lastError: string | null;
  /** ISO 8601 — base del backoff entre reintentos. */
  lastAttemptAt: string | null;
}

export interface FiberAutoProvisionAttemptRepository {
  find(taskId: string, onuSn: string): Promise<FiberAutoProvisionAttempt | null>;
  /** Upsert por (taskId, onuSn). */
  save(attempt: FiberAutoProvisionAttempt): Promise<void>;
}
