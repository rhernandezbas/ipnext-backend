/**
 * messaging-bulk (F2, design §2.1) — port para el proveedor de templates de
 * WhatsApp. NUEVO, NO extiende `ChatwootGateway`: templates + primer-contacto-
 * outbound es responsabilidad distinta (crear el hilo desde cero, fuera de la
 * ventana 24h) de `ChatwootGateway.sendMessage` (ops sobre una conversación
 * existente, F1, estable). Port separado = swap de proveedor sin tocar el
 * núcleo (ISP — Interface Segregation Principle).
 *
 * Send-path LOCKED = Twilio Content directo (D2). El adapter real
 * (`TwilioContentGateway`, Batch 5) implementa esto contra la API de Twilio; el
 * fake in-memory (`InMemoryTemplateMessagingGateway`, Batch 3) lo implementa
 * para tests. Los use cases NUNCA ven JSON crudo del proveedor.
 */

/** DTO de dominio de un template — nunca el objeto crudo de Twilio. */
export interface TemplateDto {
  /** ContentSid de Twilio (HX…) — el `templateRef` enviable. */
  contentSid: string;
  friendlyName: string;
  /** ej. 'es'. */
  language: string;
  /** Nombres/sample de las variables declaradas por el template. */
  variables: Record<string, string>;
  approvalStatus: 'approved' | 'pending' | 'rejected' | 'unsubmitted';
  /** MARKETING | UTILITY | AUTHENTICATION. */
  category?: string;
  /**
   * messaging-bulk v1.1 (preview modal) — texto plano del template (el `body`
   * del tipo `twilio/text` u equivalente dentro de `content_templates`), para
   * que el FE muestre el mensaje real en vez de solo los placeholders
   * `{{1}}`/`{{2}}`. `''` cuando el template no declara ningún tipo con body de
   * texto plano — NUNCA `undefined` (el FE siempre puede renderizarlo).
   */
  body: string;
}

export interface SendTemplateResult {
  /** SM… (Message SID) de Twilio. */
  providerId: string;
  /** Raw de Twilio (queued | sent | accepted …) — el use case lo mapea. */
  status: string;
}

/**
 * Change 3 (templates CRUD) — input para CREAR un template en el proveedor
 * (shape de la Content API de Twilio: `friendly_name`, `language`, `variables`
 * como mapa índice→sample, y el `body` del tipo `twilio/text`). Es el contrato
 * de DOMINIO entre el use case y el port; el DTO HTTP (`messaging-templates.dto`)
 * es distinto (trae `category` y `variables[]`) y el use case mapea uno al otro.
 */
export interface CreateTemplateInput {
  friendlyName: string;
  language: string;
  /** Mapa índice→sample (Twilio `variables: {"1":"..."}`). Puede ir vacío. */
  variables: Record<string, string>;
  /** Texto plano del body (`types: {"twilio/text": {body}}`). */
  body: string;
}

/**
 * Change 3 (templates CRUD) — port de ADMINISTRACIÓN de templates (VER/CREAR/
 * SUBMIT/BORRAR directo contra la Content API de Twilio). SEGREGADO de
 * `TemplateMessagingPort` (ISP, el mismo principio que motiva este archivo): el
 * send-path (F2, estable) y sus fakes `{listTemplates, sendTemplate}` NO deben
 * verse forzados a implementar el CRUD, y viceversa. El adapter real
 * (`TwilioContentGateway`) implementa AMBOS ports; el fake in-memory
 * (`InMemoryTemplateMessagingGateway`) también, para el seam de TDD.
 *
 * Los use cases NUNCA ven el JSON crudo del proveedor — `createTemplate`/
 * `getTemplate` devuelven `TemplateDto` curado.
 */
export interface TemplateAdminPort {
  /** POST `/v1/Content` (JSON). Devuelve el template recién creado (unsubmitted). */
  createTemplate(input: CreateTemplateInput): Promise<TemplateDto>;
  /** GET `/v1/Content/{sid}`. 404 del proveedor → `TemplateNotFoundError`. */
  getTemplate(contentSid: string): Promise<TemplateDto>;
  /**
   * DELETE `/v1/Content/{sid}?deleteInWaba={bool}`. `deleteInWaba=true` borra
   * TAMBIÉN de Meta/WABA (irreversible). 404 → `TemplateNotFoundError`.
   */
  deleteTemplate(contentSid: string, deleteInWaba?: boolean): Promise<void>;
  /**
   * POST `/v1/Content/{sid}/ApprovalRequests/whatsapp` con `{name, category}`.
   * `name` YA viene normalizado (lowercase_alfanum) y `category` YA validada por
   * el use case.
   */
  submitForApproval(contentSid: string, name: string, category: string): Promise<void>;
}

export interface TemplateMessagingPort {
  /** Lista templates del proveedor. `ListTemplates` filtra los `approved`. */
  listTemplates(): Promise<TemplateDto[]>;
  /**
   * Envía UN template. `to` = E164 con '+' (ej '+5493364xxxxxx'); el adapter
   * le antepone 'whatsapp:'. `variables` = mapa índice/nombre→valor ya
   * resuelto por el use case.
   *
   * Errores: transient (429/5xx/red) → `TemplateProviderUnavailableError`
   * (retryable); 4xx per-mensaje (número inválido, template no aprobado) →
   * `TemplateSendRejectedError` (terminal para ESE destinatario, no aborta el
   * lote).
   */
  sendTemplate(to: string, contentSid: string, variables: Record<string, string>): Promise<SendTemplateResult>;
}
