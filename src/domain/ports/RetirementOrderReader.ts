export interface RetirementTaskQuery {
  /** Contract of the baja — matches ScheduledTask.contractId. */
  contractId?: string;
  /** Client of the baja — matches ScheduledTask.customerId. */
  clientId?: string;
}

export interface RetirementTaskResult {
  exists: boolean;
  /** Id of a matching task (for linking) — only present when exists=true. */
  taskId?: string;
}

/**
 * actions-worklist (BAJA-1) — thin read port over ScheduledTask⋈Project:
 * "does this baja already have an equipment-retirement order?"
 *
 * A task counts iff it belongs to a Project with allowsEquipmentRetirement=true
 * AND it references the contract (contractId) OR the client (customerId).
 * An empty query (no contractId, no clientId) NEVER matches — guards the
 * accidental match-everything OR.
 */
export interface RetirementOrderReader {
  hasRetirementTask(query: RetirementTaskQuery): Promise<RetirementTaskResult>;
}
