/**
 * Result codes created in IClass specifically for closing a Service Order FROM
 * Prominense: no survey attached, associated to every SO type. Used as a fallback
 * when the operator's chosen result code is rejected because it either isn't
 * associated to the SO type (ICLERR_0216) or its survey has mandatory questions
 * (ICLERR_0217) — true for every operational result code.
 *
 * MUST be sent in UPPERCASE exactly as written here.
 */
export const ICLASS_COMPLETED_IN_PROMINENSE = 'COMPLETADA EN PROMINENSE';
export const ICLASS_CANCELLED_IN_PROMINENSE = 'CANCELADA EN PROMINENSE';
