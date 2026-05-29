/**
 * Normalized shapes for CLOSED IClass Service Orders pulled back into ipnext.
 *
 * IClass numeric ids (SO id, survey id, ...) exceed 2^53 (e.g. pesquisaId
 * 243692190673731070), so they are carried as STRINGS in the domain to preserve
 * precision and stay JSON-safe; the Prisma adapter converts to BigInt columns.
 *
 * Timestamps are ISO-8601 strings (null when absent).
 */

export interface SoStatusHistoryEntry {
  iclassOsStatusId: string;
  occurredAt: string | null;
  /** Status code as string ('7' = ENCERRADO/Concluida, '4' = FECHADA, '50' = APROVAÇÃO, ...). */
  statusCode: string;
  statusDescription: string;
  durationMinutes: number | null;
  teamLogin: string | null;
  commentary: string | null;
}

export interface SoChecklistAnswer {
  questionId: string | null;
  questionText: string;
  /** 'Texto' | 'Foto' | ... */
  questionType: string;
  answerOrder: number;
  answerText: string | null;
  /** true when questionType === 'Foto' — IClass v2 returns no photo URL. */
  photoMissing: boolean;
}

export interface SoChecklist {
  iclassSurveyId: string;
  surveyAt: string | null;
  answers: SoChecklistAnswer[];
}

export interface SoMaterial {
  iclassOsMaterialId: string;
  materialCode: string | null;
  materialDescription: string | null;
  qty: number;
  unitValue: number | null;
  totalValue: number | null;
}

export interface SoEquipmentEvent {
  occurredAt: string | null;
  /** install | remove | move */
  type: string | null;
  serialNumber: string | null;
  mac: string | null;
  patrimonialNo: string | null;
  modelDescription: string | null;
}

/**
 * Core fields available directly from the `/serviceorders` LIST response (which,
 * confirmed in recon, equals the detail shape). No children and no derived fields
 * — the ingest use-case adds those.
 */
export interface ClosedServiceOrderSummary {
  /** IClass numeric SO id (PK), as string. */
  iclassId: string;
  /** SO `codigo`. For OS we created this equals ScheduledTask.sequenceNumber. */
  iclassCodigo: string;
  clusterName: string;
  thirdPartyCode: string | null;
  nodeCode: string | null;
  soTypeDescription: string | null;

  customerCode: string | null;
  customerName: string | null;
  addressCode: string | null;
  addressLine: string | null;
  addressCity: string | null;
  addressLat: number | null;
  addressLng: number | null;

  /** status.id as string ('7' terminal). */
  statusCode: string;
  statusDescription: string;

  requestedAt: string | null;
  scheduledFor: string | null;
  availableAt: string | null;
  serviceStartedAt: string | null;
  serviceEndedAt: string | null;

  /** motivoFechamento — the result-code name. */
  resultCodeName: string | null;
  closedByLogin: string | null;
  closedByName: string | null;
  closeLatitude: number | null;
  closeLongitude: number | null;
  closeGpsAt: string | null;
  billingAmount: number | null;

  technicianNote: string | null;
  internalNote: string | null;
  commentaryLog: string | null;

  teamLogin: string | null;
  teamTechnicianName: string | null;
  teamPhone: string | null;
  teamEmail: string | null;

  iclassCreatedAt: string | null;
  /** alteradoPor.data — idempotency key. */
  iclassUpdatedAt: string | null;

  /** Full SO snapshot for forensics. */
  rawDetail: Record<string, unknown>;
}

/**
 * Full closed-SO aggregate persisted by the mirror: the summary + children +
 * fields derived by the use-case (closedAt/firstClosedAt/approvedAt from history,
 * resultCodeType joined from the result-code catalog).
 */
export interface ClosedServiceOrder extends ClosedServiceOrderSummary {
  /** status 7 transition (final) — derived from history. */
  closedAt: string | null;
  /** status 4 transition (technician close) — derived from history. */
  firstClosedAt: string | null;
  /** status 50 transition (approval) — derived from history. */
  approvedAt: string | null;
  /** Sucesso | Falha | ... — joined from the result-code catalog by resultCodeName. */
  resultCodeType: string | null;

  history: SoStatusHistoryEntry[];
  checklists: SoChecklist[];
  materials: SoMaterial[];
  equipmentEvents: SoEquipmentEvent[];
}
