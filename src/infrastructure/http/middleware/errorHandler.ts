import { Request, Response, NextFunction } from 'express';
import { DomainError } from '@domain/errors';
import { OrchestratorRejectedError } from '@domain/errors/pppoe';
import { domainErrorToCode } from '@application/util/domainErrorToCode';

/**
 * Maps domain error codes to HTTP status codes. This is the single source of truth
 * for the API's error-to-status contract — production (app.ts) and route tests both
 * exercise THIS handler so the mapping cannot drift out from under the tests.
 */
const statusMap: Record<string, number> = {
  // zones (customer-zones-map)
  ZONE_NOT_FOUND: 404,
  INVALID_POLYGON: 422,
  CLIENT_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  STAGE_NOT_FOUND: 404,
  WORKFLOW_NOT_FOUND: 404,
  PROJECT_CATEGORY_NOT_FOUND: 404,
  PROJECT_TYPE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  FLAG_NOT_FOUND: 404,
  MISSING_REQUIRED_FIELDS: 422,
  ICLASS_NODE_NOT_FOUND: 422,
  ICLASS_NODE_NOT_ASSIGNABLE: 422,
  ICLASS_REJECTED: 422,
  ICLASS_UNAVAILABLE: 502,
  MISSING_PROJECT_FOR_ICLASS: 422,
  MISSING_ICLASS_MAPPING: 422,
  ICLASS_SO_TYPE_INACTIVE: 422,
  ICLASS_SO_TYPE_NOT_FOUND: 404,
  ICLASS_RESULT_CODE_NOT_FOUND: 404,
  ICLASS_STATUS_NOT_FOUND: 404,
  // IClass OS actions (Ola A + Ola B)
  ICLASS_ACTION_DISABLED: 409,
  ICLASS_TASK_NOT_OPEN: 409,
  ICLASS_ALREADY_CLOSED: 409,
  ICLASS_NO_SERVICE_ORDER: 422,
  ICLASS_TEAM_NOT_ASSIGNABLE: 422,
  AUTHENTICATION_ERROR: 401,
  SPLYNX_UNAVAILABLE: 502,
  // PPPoE enforcement (Fase C): backend de corte inalcanzable.
  ROUTER_UNREACHABLE: 502,
  ORCHESTRATOR_UNREACHABLE: 502,
  // service-transfer (W2): contrato destino inexistente en POST /pppoe/:id/transfer (y cualquier
  // otra ruta que forwardee ContractNotFoundError al handler global — 404 es su semántica real;
  // las rutas legacy que lo mapean inline no pasan por acá).
  CONTRACT_NOT_FOUND: 404,
  // PPPoE management errors
  PPPOE_NOT_FOUND: 404,
  PPPOE_USERNAME_TAKEN: 409,
  // service-transfer fix wave (MEDIUM-4): residuo pending de un recreate parcial en el destino
  // → 409 distinguible con retry direccionado (DELETE /pppoe/:id de la fila pending).
  PPPOE_TRANSFER_PENDING_RESIDUE: 409,
  PPPOE_ALREADY_ASSOCIATED: 409,
  PPPOE_CONTRACT_ALREADY_HAS_SERVICE: 409,
  PPPOE_PROFILE_REQUIRED: 422,
  PPPOE_INGEST_NOT_SUPPORTED: 422,
  PPPOE_RENAME_NAS_NOT_SUPPORTED: 422,
  // ip-allocator (FindFreeIp)
  NAS_NOT_FOUND: 404,
  NO_POOL_FOR_NAS_TYPE: 404,
  NO_FREE_IP: 422,
  // pppoe-move-nas (fix wave 1): guards del move — fuente ÚNICA del mapeo (nada de 409 inline).
  PPPOE_MOVE_MIXED_NAS_TYPES: 409,
  PPPOE_TERMINATED: 409,
  PPPOE_MOVE_PUBLIC_IP: 409,
  // pppoe-preprovision (REQ-PRE-4): pendiente de instalación (nasId null) no operable → 409.
  PPPOE_PENDING_INSTALL: 409,
  // pppoe-preprovision D6.5: adoptar un pendiente en un NAS legacy (no-radius) → 409.
  PPPOE_PENDING_LEGACY_NAS: 409,
  // pppoe-preprovision D7.3: carrera doble-adopción perdida (otro actor adoptó primero) → 409.
  PPPOE_CONCURRENT_ADOPTION: 409,
  WORKFLOW_NAME_CONFLICT: 409,
  DEFAULT_WORKFLOW_PROTECTED: 409,
  WORKFLOW_IN_USE: 409,
  STAGE_IN_USE: 409,
  STAGE_NAME_CONFLICT: 409,
  // IClass closure → inventory
  SUGGESTION_NOT_FOUND: 404,
  SUGGESTION_ALREADY_CONFIRMED: 409,
  SUGGESTION_INCOMPLETE: 422,
  TASK_HAS_NO_SERVICE: 409,
  TASK_HAS_NO_CONTRACT: 409,
  PROJECT_CATEGORY_NAME_CONFLICT: 409,
  PROJECT_CATEGORY_IN_USE: 409,
  PROJECT_TYPE_NAME_CONFLICT: 409,
  PROJECT_TYPE_IN_USE: 409,
  REORDER_SET_MISMATCH: 400,
  // SDD #2 — RbacUser management error codes
  USER_NOT_FOUND: 404,
  ROLE_NOT_FOUND: 404,
  LOGIN_ALREADY_TAKEN: 409,
  EMAIL_ALREADY_TAKEN: 409,
  PASSWORD_TOO_SHORT: 400,
  AT_LEAST_ONE_ROLE_REQUIRED: 400,
  CANNOT_DELETE_SELF: 403,
  CANNOT_REMOVE_LAST_SUPER_ADMIN: 403,
  INVALID_OLD_PASSWORD: 403,
  // SDD #3 Phase 4a — role-permissions routes error codes
  SUPER_ADMIN_IMMUTABLE: 400,
  INVALID_PERMISSION_IDS: 400,
  // SDD #3 Phase 4b — role catalog mutation routes error codes
  ROLE_CODE_TAKEN: 409,
  ROLE_IS_SYSTEM: 403,
  VALIDATION_ERROR: 400,
  // SDD #5 — sessions
  SESSION_NOT_FOUND: 404,
  // SDD #6a — auth hardening
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  PASSWORD_POLICY: 400,
  // inventory-confirm-dedup-replace
  DUPLICATE_INSTALLED_ITEM: 409,
  NO_REPLACE_TARGET: 409,
  // task-manual-inventory-item
  INVALID_ITEM_TYPE: 422,
  // inventory-technician-stock (EPIC #38 W5a)
  INSUFFICIENT_STOCK: 422,
  ASSET_NOT_AT_DEPOT: 422,
  // retire-with-destination (Cambio B) — asset drifted out of `installed`
  ASSET_NOT_INSTALLED: 409,
  // uisp-integration — used for 404 on GET /sites/:uispId AND 422 on NetworkSite link
  UISP_SITE_NOT_FOUND: 422,
  UISP_UNAVAILABLE: 502,
  // #53 — network task requires a non-blank address
  NETWORK_TASK_ADDRESS_REQUIRED: 422,
  // #54 — network task requires a non-blank iclassCityCode (locality)
  NETWORK_TASK_LOCALITY_REQUIRED: 422,
  // #79 — SLA timer thresholds must satisfy dangerMinutes > warnMinutes
  TICKET_SLA_THRESHOLD_ORDER: 422,
  // async-error-sweep — #66: FibraTaskNoSiteError es defensa en profundidad de
  // CreateTask (el superRefine del DTO cubre el caso normal con 422 inline).
  // NO está mapeado inline en POST /scheduling → post-sweep llega acá via
  // next(err); el wire contract congelado es 422 FIBRA_TASK_NO_SITE.
  FIBRA_TASK_NO_SITE: 422,
  // task-photos — adjuntos de tarea
  UNSUPPORTED_ATTACHMENT_TYPE: 415,
  TOO_MANY_ATTACHMENTS: 422,
  ATTACHMENT_NOT_FOUND: 404,
  IMAGE_TOO_LARGE: 422,
  STORAGE_NOT_CONFIGURED: 503,
  // actions-worklist (W2) — worklist de titularidad
  OWNERSHIP_CASE_NOT_FOUND: 404,
  INVALID_CANDIDATE_PICK: 422,
  INVALID_TARGET_ASSIGNMENT: 422,
  INVALID_CASE_TRANSITION: 422,
  DISMISS_REASON_REQUIRED: 400,
  // messaging-inbox (F1) — inbox WhatsApp/Chatwoot. INVALID_SIGNATURE/STALE_TIMESTAMP (401)
  // se responden directo desde el middleware HMAC, no pasan por acá (ver domain/errors/messaging.ts).
  CONVERSATION_NOT_FOUND: 404,
  MESSAGING_WINDOW_EXPIRED: 422,
  CHATWOOT_UNAVAILABLE: 503,
  // inbox-template-send (TS-2) — SendTemplateMessage no encuentra un E164 usable
  // (ni contactPhoneE164 ni el fallback toWhatsAppE164(contactPhone)).
  CONVERSATION_PHONE_MISSING: 422,
  // messaging-inbox-v2 (F1.5, RICH-1 #4) — client-context endpoint: clientId query
  // param not among the conversation's candidates.
  CLIENT_ID_NOT_A_CANDIDATE: 400,
  // messaging-inbox-v2-media (F1.5 fase A, Tanda 1) — adjuntos de chat (fotos/videos/
  // audios/docs entrantes por WhatsApp). Mismo criterio HTTP que task-photos.
  CHAT_ATTACHMENT_TOO_LARGE: 413,
  CHAT_ATTACHMENT_NOT_FOUND: 404,
  CHAT_ATTACHMENT_NOT_READY: 409,
  // messaging-inbox-v2-media (F1.5 fase A, Tanda 2 · SEND-1) — enviar media: el
  // contentType de un adjunto SALIENTE no es clasificable (vacío/ausente).
  CHAT_ATTACHMENT_UNSUPPORTED_TYPE: 415,
  // messaging-bulk (F2) — envío masivo por template WhatsApp (Twilio directo).
  TEMPLATE_PROVIDER_UNAVAILABLE: 503,
  // messaging-bulk fix wave (FIX-2) — auth/config sistémica del proveedor
  // (token rotado, accountSid vacío). Aborta el run; rara vez llega al handler
  // HTTP (el envío es fire-and-forget), entrada defensiva.
  TEMPLATE_PROVIDER_MISCONFIGURED: 503,
  TEMPLATE_SEND_REJECTED: 422,
  TEMPLATE_NOT_APPROVED: 422,
  MISSING_TEMPLATE_VARIABLES: 422,
  EMPTY_SEGMENT: 422,
  // messaging-bulk fix wave 2 (FIX-8) — segmento sin criterio (apuntaría a TODA
  // la base): request inválido del cliente → 400.
  UNFILTERED_SEGMENT: 400,
  // manual-recipients (MAN-3) — la request trae manualClientIds que no resuelven
  // a ningún Client: bien formada pero referencia entidades inexistentes → 422
  // (mismo criterio que EMPTY_SEGMENT / MISSING_TEMPLATE_VARIABLES).
  MANUAL_RECIPIENTS_NOT_FOUND: 422,
  // manual-recipients (FIX-3) — la lista manual excede la cota MAX_MANUAL_RECIPIENTS:
  // rechazo limpio ANTES de reventar el límite de bind params de Postgres (mismo
  // criterio 422 que TOO_MANY_ATTACHMENTS — bien formada pero excede un tope).
  TOO_MANY_MANUAL_RECIPIENTS: 422,
  // bulk-csv-recipients (CSV-5) — el 4to dominio (manualContacts) espeja el mismo
  // criterio 422 que TOO_MANY_MANUAL_RECIPIENTS: cota independiente, rechazo ANTES
  // de tocar la DB.
  TOO_MANY_MANUAL_CONTACTS: 422,
  CAMPAIGN_NOT_FOUND: 404,
  CAMPAIGN_ALREADY_FINISHED: 409,
  // Change 3 (templates CRUD) — ver/crear/submit/borrar templates WhatsApp.
  // TEMPLATE_NOT_FOUND: GET/DELETE de un contentSid inexistente (Twilio 404).
  // TEMPLATE_IN_USE: borrar un template retenido por una campaña activa (guard).
  TEMPLATE_NOT_FOUND: 404,
  TEMPLATE_IN_USE: 409,
  // smartolt-provision (K2) — aprovisionamiento de ONUs fibra Huawei.
  // OltProvisioningError trae el reason tipado; acá solo vive el mapeo code→status:
  //   not_configured → 503 (envs SMARTOLT_* ausentes: feature apagada limpia)
  //   unreachable    → 502 (misma semántica que ROUTER/ORCHESTRATOR_UNREACHABLE)
  //   rejected       → 422 (SmartOLT respondió y rechazó — p.ej. "Invalid parameters")
  SMARTOLT_NOT_CONFIGURED: 503,
  SMARTOLT_UNREACHABLE: 502,
  SMARTOLT_REJECTED: 422,
  ONU_NOT_HUAWEI: 422,
  // fix wave LOW-a: ONU detectada pero SmartOLT no ofrece authorize → conflicto de estado.
  ONU_NOT_AUTHORIZABLE: 409,
  FIBER_VLAN_REQUIRED: 422,
  ONU_NOT_FOUND: 404,
  SMARTOLT_OLT_NOT_FOUND: 404,
  // F1.5-C2 (asignación) — SetConversationArea reusa TicketAreaNotFoundError
  // (`@domain/errors/tickets`) para el area inexistente referenciado. El código
  // ya existía sin entrada explícita acá (ticketAreas.routes.ts lo intercepta
  // inline vía `instanceof` ANTES de llegar a este handler global, así que nunca
  // había caído en el fallback `?? 400`). messaging.routes.ts sigue el convenio
  // try/catch → next(err) SIN checks inline por código — agregar la entrada acá
  // hace que el mismo error resuelva 404 en AMBOS routers, sin tocar
  // ticketAreas.routes.ts ni sus tests (nunca llegan al fallback global).
  TICKET_AREA_NOT_FOUND: 404,
};

/** Express global error-handling middleware. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // #44 — body-parser raises `entity.too.large` when a request body exceeds the
  // configured limit (e.g. the 8mb path-scoped parser on /api/tickets/:id/comments).
  // Map it to 413 BEFORE the DomainError check so it never falls through to the 500 handler.
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  if (err instanceof DomainError) {
    // OrchestratorRejectedError re-envía el status HTTP que devolvió el orchestrator (4xx).
    // El statusMap no puede manejarlo estáticamente porque el status es dinámico.
    const status = err instanceof OrchestratorRejectedError
      ? err.upstreamStatus
      : (statusMap[err.code] ?? 400);
    const mapped = domainErrorToCode(err);
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    // Surface the missing field names so the front-end can drive its modal.
    if (mapped?.missingFields !== undefined) {
      body['missingFields'] = mapped.missingFields;
    }
    // Surface the IClass rejection detail (e.g. ICLERR_0045 ...) for the front-end.
    if (mapped?.reason !== undefined) {
      body['reason'] = mapped.reason;
    }
    // Surface projectTitle so the FE can render "Project «title» has no mapping".
    if (mapped?.projectTitle !== undefined) {
      body['projectTitle'] = mapped.projectTitle;
    }
    // Surface iclassSoTypeCode so the FE can render "Type «code» was deactivated".
    if (mapped?.iclassSoTypeCode !== undefined) {
      body['iclassSoTypeCode'] = mapped.iclassSoTypeCode;
    }
    // messaging-bulk (F2, CAMP-3) — spec.md's wire contract names this `missing`
    // (distinct from the pre-existing `missingFields` used by another feature).
    if (mapped?.missing !== undefined) {
      body['missing'] = mapped.missing;
    }
    // Change 3 (templates CRUD) — TemplateInUseByCampaignError expone CUÁLES
    // campañas activas retienen el template (no solo el conteo del message).
    if (mapped?.campaignIds !== undefined) {
      body['campaignIds'] = mapped.campaignIds;
    }
    // manual-recipients (MAN-3) — ManualRecipientsNotFoundError expone CUÁLES
    // manualClientIds no existen para que el FE señale las selecciones inválidas.
    if (mapped?.missingClientIds !== undefined) {
      body['missingClientIds'] = mapped.missingClientIds;
    }
    res.status(status).json(body);
    return;
  }
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
