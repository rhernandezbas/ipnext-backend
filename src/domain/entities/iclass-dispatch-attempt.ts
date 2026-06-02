/**
 * IClass dispatch attempt — entity de dominio.
 *
 * Registra cada intento de envio de una tarea a IClass (exito o fallo).
 * `outcome` se almacena como String en la DB (sin enum Postgres — AD-2).
 * La whitelist vive aqui para que el codigo TS siempre use valores tipados.
 */

/** Whitelist de outcomes (AD-2). La DB guarda `outcome` como String (sin enum). */
export const ICLASS_DISPATCH_OUTCOMES = [
  'success',
  'node_not_found',
  'rejected',
  'unavailable',
  'error',
] as const;

export type IClassDispatchOutcome = (typeof ICLASS_DISPATCH_OUTCOMES)[number];

/** Un intento de envio de una tarea a IClass (exito o fallo). Entidad de dominio. */
export interface IClassDispatchAttempt {
  id: string;
  taskId: string;
  outcome: IClassDispatchOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedNodeCode: string | null;
  resolvedNodeCode: string | null;
  actorId: string | null;
  createdAt: string; // ISO
}

/** Input para registrar un intento (sin id/createdAt — los pone el adapter). */
export interface RecordDispatchAttemptInput {
  taskId: string;
  outcome: IClassDispatchOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptedNodeCode?: string | null;
  resolvedNodeCode?: string | null;
  actorId?: string | null;
}
