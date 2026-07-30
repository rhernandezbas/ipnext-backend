import { Customer, Contract, ClientLog } from '../entities/customer';
import { PaginatedResult, PaginatedQuery } from '../entities/pagination';

export interface ListClientsQuery extends PaginatedQuery {
  search?: string;
  status?: string;
  /**
   * messaging-bulk (F2, T6.1) — multi-status (OR), ADITIVO. Si viene con al
   * menos un elemento, tiene PRECEDENCIA sobre `status` (single, F1 — path
   * intacto cuando `statuses` NO llega).
   */
  statuses?: string[];
  /** messaging-bulk (F2, T6.1) — umbral inferior de `Client.balanceDue`. */
  balanceMin?: number;
  /** messaging-bulk (F2, T6.1) — umbral superior de `Client.balanceDue`. */
  balanceMax?: number;
}

export interface ListLogsQuery extends PaginatedQuery {
  clientId: string;
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  phone: string;
  login: string;
  status?: 'active' | 'inactive' | 'blocked' | 'new';
  address?: string | null;
  city?: string | null;
  country?: string | null;
  splynxId?: string | null;
  customAttributes?: Record<string, unknown> | null;
}

export interface ClientStats {
  total: number;
  active: number;
  inactive: number;
  blocked: number;
  late: number;
  baja: number;
}

export interface UpdateClientLocationInput {
  lat?: number | null;
  lng?: number | null;
  plusCode?: string | null;
}

/**
 * recapture-active-client-match — narrow candidate-contact shape for the
 * "posible cliente activo" detector (design.md Decisión 1). Deliberately NOT
 * the full `Customer` entity — only the 4 columns the in-memory matcher needs.
 * phone/email are nullable: real GR data can have gaps even though the Client
 * table columns are non-null strings today (defensive, matches matchActiveClient's
 * null-safe contract).
 */
export interface ActiveClientContact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

/**
 * fix/portal-balance-from-invoices — UNA entrada de saldo POR MONEDA ISO
 * 4217 (nunca el código crudo de GR — ver `normalizeGrCurrency`). Distintas
 * monedas jamás se suman entre sí: medido en prod, hay clientes con facturas
 * impagas en `PES` (`ARS`) Y `DOL` (`USD`) al mismo tiempo — sumarlas daría
 * un número sin sentido económico.
 */
export interface PortalBalanceEntry {
  /** ISO 4217 normalizado (`normalizeGrCurrency`), o `'DESCONOCIDA'` si el
   *  cliente tiene deuda con `Invoice.currency` ausente Y con al menos otra
   *  moneda conocida (ver doc de `normalizeGrCurrency` para el porqué no se
   *  fusiona con esa moneda conocida). */
  currency: string;
  /** Suma de `Invoice.balance` no pagado en ESTA moneda únicamente. */
  amount: number;
}

/**
 * fix/portal-balance-from-invoices — resultado agregado del saldo del portal,
 * calculado EXCLUSIVAMENTE sobre `Invoice` (Prominense), NUNCA sobre
 * `Client.balanceDue` (el agregado que escribe el sync de GR). Motivo: en
 * prod, GR puede reportar `balanceDue = 0` mientras `Invoice` tiene facturas
 * vencidas impagas (visto con HERNANDEZ RONALD, 5 facturas vencidas por
 * $100.886,90 con `Client.balanceDue = 0`) — el saldo y la lista de facturas
 * SIEMPRE tienen que salir del mismo dato para no contradecirse de cara al
 * cliente (portal-self-service spec "Mi resumen").
 *
 * fix wave (multi-moneda) — `Invoice.currency` NO está agrupado por moneda en
 * la versión anterior de este tipo (`unpaidBalance: number` único): en prod,
 * `Invoice.currency` tiene `PES` (7430 filas) y `DOL` (43 filas) — códigos de
 * GR, NO ISO 4217 — y hay clientes con facturas impagas en AMBAS monedas.
 * Sumarlas en un solo número es basura (mezcla pesos con dólares). Ahora
 * `balances` trae UNA entrada por moneda ISO, ordenadas por `amount` DESC.
 */
export interface PortalBalanceSummary {
  /**
   * Entradas por moneda, ordenadas por `amount` DESC. NUNCA vacío si este
   * objeto no es `null` — el caso "todo pagado" se modela con UNA entrada
   * `{ currency: <ISO de la factura más reciente>, amount: 0 }` (= "al día",
   * coherente con una lista de facturas vacía-de-deuda). La ausencia total
   * de facturas se modela devolviendo `null` en `getPortalBalanceSummary`,
   * NUNCA con `balances: []`.
   */
  balances: PortalBalanceEntry[];
  /**
   * Frescura del NÚMERO mostrado (`balances`, sin distinguir por moneda —
   * una sola fecha para todo el objeto), no una fecha inventada:
   * `max(createdAt)` de las facturas impagas que componen la suma (de
   * CUALQUIER moneda); si no hay impagas (todas pagadas), `max(createdAt)`
   * de TODAS las facturas del cliente (seguimos teniendo datos, solo que
   * ninguno es deuda viva).
   */
  lastUpdatedAt: string;
}

export interface CustomerRepository {
  list(query: ListClientsQuery): Promise<PaginatedResult<Customer>>;
  findById(id: string): Promise<Customer>;
  create(data: CreateCustomerInput): Promise<Customer>;
  /** Returns true when a row was deleted, false when the id did not exist. */
  delete(id: string): Promise<boolean>;
  stats(): Promise<ClientStats>;
  listContracts(clientId: string): Promise<Contract[]>;
  listInvoices(clientId: string): Promise<import('../entities/billing').Invoice[]>;
  /**
   * fix/portal-balance-from-invoices — saldo del portal agregado EN LA DB
   * (Prisma `aggregate`/`findFirst` sobre `Invoice`, jamás trayendo todas las
   * filas a memoria — ver `PrismaCustomerRepository.getPortalBalanceSummary`).
   * Devuelve `null` cuando el cliente no tiene NINGUNA factura espejada (
   * "sin datos", distinto de `unpaidBalance: 0` = "al día"). Consumido por
   * `GetPortalMe` (portal-self-service spec "Mi resumen").
   */
  getPortalBalanceSummary(clientId: string): Promise<PortalBalanceSummary | null>;
  listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>>;
  /**
   * client-geolocation — update ONLY the Prominense-owned GPS fields.
   * Whitelist: lat, lng, plusCode. GR fields are NEVER touched.
   * Returns the updated Customer, or null if the id does not exist.
   */
  updateLocation(id: string, data: UpdateClientLocationInput): Promise<Customer | null>;
  /**
   * recapture-active-client-match — batch candidate set for the "posible cliente
   * activo" detector. Returns EVERY client with status='active' (id/name/phone/
   * email only, 4 narrow columns — NOT the full Customer). ONE call serves an
   * entire list page or a single detail lookup; the caller matches in memory via
   * `matchActiveClient` (design.md Decisión 1 — no Prisma OR-query, no N+1).
   */
  listActiveContacts(): Promise<ActiveClientContact[]>;
}

// ---------------------------------------------------------------------------
// messaging-bulk (F2) — segment candidate source (design §4.2)
// ---------------------------------------------------------------------------

/**
 * messaging-bulk (F2) — segment filter for `listSegmentRecipients`. `statuses`
 * empty = sin filtro de status (SEG-1 "rango sin status"; también el escape
 * hatch narrow de OPT-2/T6.5 para matchear contra CUALQUIER estado).
 */
export interface CampaignSegmentFilter {
  statuses: string[];
  balanceMin?: number;
  balanceMax?: number;
  /**
   * node-segment — nodo (`NetworkSite.id`). Ausente/null/'' = sin filtro. El
   * adapter resuelve "≥1 contrato del cliente en este nodo" (Prisma:
   * `contracts: { some: {...} }` — ver `buildSegmentWhere`).
   */
  networkSiteId?: string | null;
  /**
   * node-segment — AP (`AccessPoint.id`), combinable con `networkSiteId` (si
   * vienen ambos, matchean en EL MISMO contrato). Ausente/null/'' = sin filtro.
   */
  accessPointId?: string | null;
}

/**
 * messaging-bulk (F2, design §4.2) — narrow candidate-contact shape para
 * resolver una campaña (Batch 3: `resolveRecipients`/`PreviewCampaignSegment`/
 * `CreateCampaign`). Deliberadamente NO la entidad `Customer` completa.
 */
export interface CampaignRecipientCandidate {
  clientId: string;
  name: string;
  phone: string | null;
  balanceDue: number | null;
  whatsappOptOutAt: string | null;
  /**
   * messaging-bulk v1.1 (preview modal — statusCounts) — el estado ACTUAL del
   * `Client` (`active`/`late`/`blocked`/…). Opcional/deliberadamente NO
   * requerido: `CampaignRecipientLookup.findRecipientCandidate` (re-check
   * per-envío, `SendCampaign`) reusa el mismo shape y NUNCA necesitó este
   * campo — hacerlo requerido hubiese forzado tocar ese path (y sus fakes) sin
   * ningún beneficio. `CampaignSegmentSource.listSegmentRecipients` SIEMPRE lo
   * completa (`resolveRecipients` lo usa para `statusCounts` + el `status` del
   * sample/paginado).
   */
  status?: string;
}

/**
 * messaging-bulk (F2) — port narrow (ISP, mismo criterio que `TemplateMessagingPort`
 * separado de `ChatwootGateway`) que resuelve el universo de candidatos de un
 * segmento. DELIBERADAMENTE separado de `CustomerRepository` en este batch
 * (Batch 3): la extensión REAL de `CustomerRepository`/`PrismaCustomerRepository`
 * con este método (T6.1-T6.3, query Prisma real + `ListClientsQuery.statuses`)
 * es explícitamente Batch 6 — fuera del alcance de este chunk de `apply`. Un
 * adapter (p.ej. `PrismaCustomerRepository`) puede implementar AMBAS interfaces
 * sin conflicto; Batch 6 decide si las fusiona en una sola o las deja separadas.
 */
export interface CampaignSegmentSource {
  listSegmentRecipients(segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]>;
}

/**
 * messaging-bulk (F2, Batch 4, SEND-5) — port narrow (ISP) para el re-check de
 * UN destinatario al momento del envío. Deliberadamente SEPARADO de
 * `CampaignSegmentSource` (no un método opcional agregado ahí): `SendCampaign`
 * NO necesita `listSegmentRecipients` (eso es de Preview/Create, Batch 3) y
 * agregar este método a `CampaignSegmentSource` habría roto los fakes ya
 * verdes de `CreateCampaign.test.ts`/`PreviewCampaignSegment.test.ts` (Batch 3,
 * NO tocar). Mismo criterio que el port `RateLimiter` agregado en Batch 2 para
 * su primer consumidor real en Batch 4 — cero riesgo, ningún adapter productivo
 * implementa esto todavía (Batch 6 decide cómo lo satisface `PrismaCustomerRepository`).
 */
export interface CampaignRecipientLookup {
  /**
   * Devuelve el estado ACTUAL del candidato (incluyendo `whatsappOptOutAt`) o
   * `null` si el `Client` ya no resuelve. `SendCampaign` lo llama INMEDIATAMENTE
   * ANTES de cada `sendTemplate` — nunca cachear el resultado entre recipients.
   */
  findRecipientCandidate(clientId: string): Promise<CampaignRecipientCandidate | null>;
}

/**
 * manual-recipients (MAN-1..MAN-3) — port narrow (ISP, mismo criterio que
 * `CampaignSegmentSource`/`CampaignRecipientLookup`/`OptOutRegistry`) para
 * resolver una LISTA MANUAL de clientes al crear/previsualizar una campaña.
 * Deliberadamente SEPARADO de `CampaignSegmentSource`: agregarle un método a esa
 * interface habría roto TODOS los fakes ya verdes de `CreateCampaign.test.ts`/
 * `PreviewCampaignSegment.test.ts`/`messagingBulk.routes.test.ts` (implementan
 * solo `listSegmentRecipients`). `PrismaCustomerRepository` implementa AMBAS sin
 * conflicto (misma instancia `customerAdapter` en el wiring).
 */
export interface ManualRecipientSource {
  /**
   * Resuelve un batch de `clientIds` a candidatos (mismo shape narrow que el
   * segmento). Devuelve SOLO los ids que EXISTEN (subset, cualquier orden) —
   * `findMany({ id: { in } })`. El caller detecta los faltantes por set-diff y
   * hace fail-loud (`ManualRecipientsNotFoundError`, MAN-3). `[]` para input
   * vacío. Selecciona `status` (para `statusCounts` del preview), a diferencia
   * de `findRecipientCandidate` (re-check per-envío) que no lo necesita.
   */
  findRecipientCandidatesByIds(clientIds: string[]): Promise<CampaignRecipientCandidate[]>;
}

/**
 * messaging-bulk (F2, OPT-1, Batch 6/T6.4) — port narrow (ISP, mismo criterio
 * que `CampaignSegmentSource`/`CampaignRecipientLookup` de arriba) para
 * registrar la baja de WhatsApp de un cliente. Deliberadamente SEPARADO de
 * `CustomerRepository`: `SplynxCustomerAdapter` (legacy) NO implementa esto —
 * solo `PrismaCustomerRepository` lo hace (Batch 6), cero riesgo para el
 * adapter legacy (mismo razonamiento que el resto de los ports narrow de este
 * archivo — batches 3/4 ya sentaron el precedente).
 */
export interface OptOutRegistry {
  /**
   * OPT-1 — setea `Client.whatsappOptOutAt = now()` SOLO si estaba `null`
   * (idempotente, primer-en-ganar: repetir sobre un cliente YA opt-out NO
   * pisa el timestamp original `T1`). Nunca lanza — ni siquiera si `clientId`
   * no resuelve a ningún `Client` (no-op silencioso, mismo criterio fail-open
   * que el resto del webhook de mensajería, HOOK-4/5).
   */
  registerOptOut(clientId: string): Promise<void>;
}
