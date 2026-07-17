/**
 * K3 (fiber-auto-watcher) — acceso del watcher a las tareas de instalación.
 * La aplicación depende de ESTA interfaz; los adapters concretos son
 * PrismaFiberAutoProvisionTaskRepository (prod) e
 * InMemoryFiberAutoProvisionTaskRepository (tests).
 */

/** Tarea candidata al auto-aprovisionamiento: serial cargado + NO archivada. */
export interface FiberAutoProvisionCandidateTask {
  id: string;
  /** Puede faltar — el watcher la skipea (sin contrato no hay a quién aprovisionar). */
  contractId: string | null;
  onuSerial: string;
  description: string | null;
}

export interface FiberAutoProvisionTaskRepository {
  /**
   * Tareas con onuSerial seteado y archivedAt null. El filtro de archivado es
   * CONTRATO del port (el adapter lo aplica en la query, no el use case).
   */
  listCandidates(): Promise<FiberAutoProvisionCandidateTask[]>;
  /**
   * Appendea una nota a la description de la tarea (read-modify-write en el
   * adapter, separada por línea en blanco). Best-effort: tarea inexistente = no-op.
   */
  appendNote(taskId: string, note: string): Promise<void>;
}
