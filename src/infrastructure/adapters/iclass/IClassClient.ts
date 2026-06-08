import axios, { AxiosInstance } from 'axios';
import {
  IClassPort,
  IClassNode,
  IClassSoTypeDescriptor,
  IClassResultCodeDescriptor,
  CreateServiceOrderInput,
  ListServiceOrdersParams,
} from '@domain/ports/IClassPort';
import {
  ClosedServiceOrderSummary,
  SoStatusHistoryEntry,
  SoChecklist,
  SoMaterial,
  SoEquipmentEvent,
} from '@domain/entities/iclass-closed-order';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

/** Default cluster — the only IPNEXT cluster in IClass. */
const DEFAULT_CLUSTER = 'IPNEXT INTERNET';
/** Backoff between sub-resource calls to dodge the "Espere um pouco" rate limit. */
const SUBRESOURCE_BACKOFF_MS = 400;
/** Window (days) scanned over recent SOs to discover active soType ids for the
 * result-code catalog sync. Under the IClass 30-day list cap. */
const RESULT_CODE_DISCOVERY_DAYS = 28;
/** Máximo de reintentos ante un HTTP 429 (rate-limit de estado). */
const MAX_RATE_LIMIT_RETRIES = 4;

export interface IClassClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  thirdPartyId: string;
  /** IClass cluster name, required on /serviceorders queries. Default "IPNEXT INTERNET". */
  clusterName?: string;
  timeoutMs?: number;
  /** TTL for the in-memory listNodes() cache (AD-2). Default 5 min. */
  nodesCacheTtlMs?: number;
  /** Injectable HTTP client for deterministic tests. */
  http?: AxiosInstance;
  /** Injectable clock for deterministic openedDate tests. */
  now?: () => Date;
  /** Override backoff for tests (default 400ms). */
  subresourceBackoffMs?: number;
  /** Límite de reintentos ante HTTP 429. Default MAX_RATE_LIMIT_RETRIES (4). */
  maxRateLimitRetries?: number;
  /** Función sleep inyectable para tests (elimina waits reales). */
  _sleep?: (ms: number) => Promise<void>;
}

/** Minimal shape of an axios-style transport error. */
function isAxiosLikeError(e: unknown): e is {
  response?: { status?: number; headers?: Record<string, unknown>; data?: { erros?: unknown } };
} {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
}

/**
 * Extrae el tiempo de espera en ms del header `Retry-After` (sólo enteros en segundos).
 * Formas de fecha HTTP y valores no numéricos son ignorados → undefined.
 */
export function parseRetryAfterMs(e: unknown): number | undefined {
  if (!isAxiosLikeError(e)) return undefined;
  const raw = e.response?.headers?.['retry-after'];
  if (raw === null || raw === undefined) return undefined;
  const seconds = parseInt(String(raw), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

/**
 * Serialize IClass `erros` to a human-readable string. Each error is `code: description`,
 * joined by "; ". Falls back to String() for unexpected shapes. Never leaks raw JSON
 * across the layer boundary — the result is a plain string carried by the domain error.
 */
function formatIClassErrors(erros: unknown): string {
  if (Array.isArray(erros)) {
    return erros
      .map(e => {
        if (e && typeof e === 'object') {
          const o = e as { code?: unknown; description?: unknown };
          const code = o.code != null ? String(o.code) : '';
          const desc = o.description != null ? String(o.description) : '';
          return code && desc ? `${code}: ${desc}` : code || desc || String(e);
        }
        return String(e);
      })
      .join('; ');
  }
  return String(erros);
}

/**
 * Adapter for the IClass v2 external API.
 *
 * Auth is Bearer: POST /auth/login {username,password} → { access_token }.
 * The token is attached to every subsequent call; on a 401 the adapter
 * re-logs in once and retries the original request. Transport failures (5xx,
 * connection errors, persistent 401) are translated to IClassUnavailableError
 * so callers never see a raw axios error. Responses are mapped to the port's
 * types — raw IClass JSON never crosses the layer boundary (REQ-OS-4).
 */
export class IClassClient implements IClassPort {
  private readonly http: AxiosInstance;
  private readonly username: string;
  private readonly password: string;
  private readonly thirdPartyId: string;
  private readonly clusterName: string;
  private readonly subresourceBackoffMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly nodesCacheTtlMs: number;

  private token: string | null = null;
  private nodesCache: { nodes: IClassNode[]; expiresAt: number } | null = null;

  constructor(opts: IClassClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.thirdPartyId = opts.thirdPartyId;
    this.clusterName = opts.clusterName ?? DEFAULT_CLUSTER;
    this.subresourceBackoffMs = opts.subresourceBackoffMs ?? SUBRESOURCE_BACKOFF_MS;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
    this.sleep = opts._sleep ?? sleep;
    this.now = opts.now ?? (() => new Date());
    this.nodesCacheTtlMs = opts.nodesCacheTtlMs ?? 5 * 60 * 1000;
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        timeout: opts.timeoutMs ?? 30000,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  async listNodes(): Promise<IClassNode[]> {
    const now = this.now().getTime();
    if (this.nodesCache && this.nodesCache.expiresAt > now) {
      return this.nodesCache.nodes;
    }
    const data = await this.authedGet<{ objects?: Array<{ codigo?: string; descricao?: string }> }>(
      `/thirdparties/${this.thirdPartyId}/nodes?pagesize=100`,
    );
    const nodes: IClassNode[] = (data.objects ?? []).map(o => ({
      code: String(o.codigo ?? ''),
      description: String(o.descricao ?? ''),
    }));
    this.nodesCache = { nodes, expiresAt: now + this.nodesCacheTtlMs };
    return nodes;
  }

  /**
   * Fetches the SO type catalog for the configured thirdParty.
   * GET /thirdparties/{thirdPartyId}/serviceorders/types?pagesize=200
   * Maps IClass `objects[]` → [{ code: trim(codigo), description: trim(descricao) }].
   * Filters out entries with an empty code after trimming (defensive).
   */
  async listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]> {
    const data = await this.authedGet<{ objects?: Array<{ codigo?: unknown; descricao?: unknown }> }>(
      `/thirdparties/${this.thirdPartyId}/serviceorders/types?pagesize=200`,
    );
    return (data.objects ?? [])
      .map(o => ({
        code: String(o.codigo ?? '').trim(),
        description: String(o.descricao ?? '').trim(),
      }))
      .filter(t => t.code.length > 0);
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    // REQ-PORT-2: adapter has no default SO type. callers MUST resolve soType from
    // the Project mapping before calling. Empty/whitespace is a programmer error.
    if (!input.soType || !input.soType.trim()) {
      throw new Error('soType is required');
    }
    const payload = this.buildServiceOrderPayload(input);
    const data = await this.authedPost<{ codigoOS?: string | null; erros?: unknown }>(
      '/serviceorders',
      payload,
    );
    if (data.erros !== null && data.erros !== undefined) {
      throw new IClassRejectedError(formatIClassErrors(data.erros));
    }
    const orderCode = data.codigoOS;
    if (!orderCode) {
      throw new IClassUnavailableError('IClass did not return an order code');
    }
    return { orderCode: String(orderCode) };
  }

  // ── Closure loop (read path) ──────────────────────────────────────────────

  async listServiceOrders(params: ListServiceOrdersParams): Promise<ClosedServiceOrderSummary[]> {
    const base = new URLSearchParams({
      clusterName: this.clusterName,
      updatedDate_begin: formatListDate(params.updatedDateBegin),
      updatedDate_end: formatListDate(params.updatedDateEnd),
      pagesize: '60',
    });
    if (params.serviceOrderCode) base.set('serviceOrderCode', params.serviceOrderCode);
    const raw = await this.fetchAllPages(`/serviceorders`, base);
    return raw.map(o => parseServiceOrderSummary(o, this.clusterName));
  }

  async getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/history`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseHistoryEntry);
  }

  async getServiceOrderChecklists(iclassId: string): Promise<SoChecklist[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/checklist`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseChecklist);
  }

  async getServiceOrderMaterials(iclassId: string): Promise<SoMaterial[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/materials`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseMaterial);
  }

  async getServiceOrderEquipmentEvents(iclassId: string): Promise<SoEquipmentEvent[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/equipments/history`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseEquipmentEvent);
  }

  async listResultCodes(): Promise<IClassResultCodeDescriptor[]> {
    // The SO-type list endpoints expose NO numeric id (verified live): neither
    // /thirdparties/{tp}/serviceorders/types nor /serviceordertypes?thirdPartyId
    // return it, and their `motivosFechamento` is empty in list view. The numeric
    // soType id only appears as `tipoOs.id` on the SO list. So we discover the
    // active soType ids from recent SOs, then fan out to each type's result codes
    // (/serviceordertypes/{id}/resultcodes), which IS populated.
    const now = this.now();
    const begin = new Date(now.getTime() - RESULT_CODE_DISCOVERY_DAYS * 24 * 60 * 60 * 1000);
    const sos = await this.fetchAllPages(
      '/serviceorders',
      new URLSearchParams({
        clusterName: this.clusterName,
        updatedDate_begin: formatListDate(begin),
        updatedDate_end: formatListDate(now),
        pagesize: '60',
      }),
    );

    const soTypeIds = new Set<string>();
    for (const o of sos) {
      const tipoOs = (o as { tipoOs?: { id?: unknown } }).tipoOs;
      if (tipoOs?.id != null) soTypeIds.add(String(tipoOs.id));
    }

    const out: IClassResultCodeDescriptor[] = [];
    const seen = new Set<string>();
    for (const id of soTypeIds) {
      await this.sleep(this.subresourceBackoffMs);
      const codes = await this.fetchAllPages(
        `/serviceordertypes/${id}/resultcodes`,
        new URLSearchParams({ pagesize: '100' }),
      );
      for (const c of codes) {
        const desc = parseResultCode(c, id);
        const key = `${id}::${desc.code}`;
        if (desc.code && !seen.has(key)) {
          seen.add(key);
          out.push(desc);
        }
      }
    }
    return out;
  }

  /**
   * GET a paginated IClass list resource, following pages while hasMoreElements.
   * Treats 204 (empty body) as an empty list and retries once on the textual
   * "Espere um pouco" rate-limit response.
   */
  private async fetchAllPages(path: string, params: URLSearchParams): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      params.set('pagenumber', String(page));
      let data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
      if (isRateLimited(data)) {
        await this.sleep(this.subresourceBackoffMs * 2);
        data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
      }
      if (!data || typeof data !== 'object') break; // 204 / empty / rate-limited text
      const body = data as { objects?: unknown[]; hasMoreElements?: boolean };
      const objects = Array.isArray(body.objects) ? body.objects : [];
      for (const o of objects) if (o && typeof o === 'object') out.push(o as Record<string, unknown>);
      if (!body.hasMoreElements || objects.length === 0) break;
      page++;
    }
    return out;
  }

  /** Build the ServiceOrderV1In payload. nodeCode = city, NO scheduledDate (REQ-OS-1, AD-5). */
  private buildServiceOrderPayload(input: CreateServiceOrderInput) {
    // soCode/addressCode carry the task sequenceNumber: short, unique per task, and
    // lets us correlate the IClass OS back to the backend task. IClass enforces a char
    // limit on these codes (ICLERR_0050); the sequenceNumber stays well within it.
    const soCode = input.soCode;
    return {
      serviceOrder: {
        soCode,
        customerCode: input.customerCode,
        addressCode: soCode,
        typeSOSummary: input.soType,
        openedDate: formatOpenedDate(this.now()),
        observation: input.description,
      },
      customer: {
        customerCode: input.customerCode,
        name: input.customerName,
        mobile: input.phone,
      },
      address: {
        addressCode: soCode,
        customerCode: input.customerCode,
        address: input.address,
        number: '',
        city: input.city,
        state: '',
        country: '',
        zipCode: '',
        nodeCode: input.nodeCode ?? input.city,
        neighborhood: '',
      },
    };
  }

  private async login(): Promise<void> {
    try {
      const res = await this.http.post('/auth/login', {
        username: this.username,
        password: this.password,
      });
      const token = (res?.data as { access_token?: string } | undefined)?.access_token;
      if (!token) throw new IClassUnavailableError('IClass login returned no access_token');
      this.token = token;
    } catch (e) {
      throw this.mapError(e);
    }
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Ejecuta `fn` con reintento automático ante 401 (re-login una vez) y ante
   * 429 (espera Retry-After o backoff exponencial, hasta maxRateLimitRetries).
   * Tras agotar reintentos 429 o ante cualquier otro error, delega a mapError.
   *
   * IMPORTANTE: el re-login 401 sólo se ejecuta en attempt===0 para no
   * interferir con el loop 429.
   */
  private async withAuthRetry<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    if (!this.token) await this.login();

    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      try {
        const res = await fn();
        return res.data;
      } catch (e) {
        // 401 → re-login una única vez (sólo en el primer intento)
        if (isAxiosLikeError(e) && e.response?.status === 401 && attempt === 0) {
          await this.login();
          continue;
        }

        // 429 → esperar y reintentar mientras queden intentos
        if (isAxiosLikeError(e) && e.response?.status === 429 && attempt < this.maxRateLimitRetries) {
          const ms = parseRetryAfterMs(e) ?? this.subresourceBackoffMs * Math.pow(2, attempt);
          await this.sleep(ms);
          continue;
        }

        // Sin reintentos disponibles o error de otro tipo → propagar
        throw this.mapError(e);
      }
    }

    // Nunca debería llegar acá (el loop siempre retorna o lanza), pero TypeScript lo requiere.
    throw this.mapError(new Error('withAuthRetry: loop exhausted unexpectedly'));
  }

  private authedGet<T>(url: string): Promise<T> {
    return this.withAuthRetry<T>(() => this.http.get(url, { headers: this.authHeaders() }));
  }

  private authedPost<T>(url: string, body: unknown): Promise<T> {
    return this.withAuthRetry<T>(() => this.http.post(url, body, { headers: this.authHeaders() }));
  }

  /** Translate transport errors to a domain error. Never leak axios cross-layer. */
  private mapError(e: unknown): Error {
    if (e instanceof IClassUnavailableError || e instanceof IClassRejectedError) return e;
    if (isAxiosLikeError(e)) {
      const status = e.response?.status;
      // HTTP 400 carrying business `erros` is an explicit rejection, not an outage.
      const erros = e.response?.data?.erros;
      if (status === 400 && erros !== null && erros !== undefined) {
        return new IClassRejectedError(formatIClassErrors(erros));
      }
      return new IClassUnavailableError(
        status ? `IClass responded with HTTP ${status}` : 'IClass connection failed',
      );
    }
    return new IClassUnavailableError();
  }
}

/** Date → "yyyy-MM-dd HH:mm:ss -0300" (IClass openedDate format). */
export function formatOpenedDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} -0300`
  );
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Date → "dd-MM-yyyy HH:mm" (IClass /serviceorders date-filter format). */
export function formatListDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** IClass returns its rate-limit notice as a 200 with a plain-text body. */
export function isRateLimited(data: unknown): boolean {
  return typeof data === 'string' && /espere um pouco/i.test(data);
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an IClass date into an ISO-8601 string (Buenos Aires, -03:00), or null.
 * Handles "dd-MM-yyyy HH:mm:ss", "dd-MM-yyyy HH:mm", and passes through ISO inputs
 * (checklist `dataPesquisa` already comes as ISO with offset).
 */
export function parseIClassDate(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim();
  if (s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, MM, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mi}:${ss}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Map a raw IClass SO (list/detail share the shape) → normalized summary. */
export function parseServiceOrderSummary(raw: Record<string, unknown>, clusterName: string): ClosedServiceOrderSummary {
  const contrato = obj(raw.contrato);
  const endereco = obj(raw.endereco);
  const node = obj(raw.node);
  const equipe = obj(raw.equipe);
  const tipoOs = obj(raw.tipoOs);
  const status = obj(raw.status);
  const criadoPor = obj(raw.criadoPor);
  const alteradoPor = obj(raw.alteradoPor);
  const credenciada = obj(raw.credenciada);
  const coords = obj(raw.coordenadasFechamento);
  return {
    iclassId: String(raw.id ?? ''),
    iclassCodigo: String(raw.codigo ?? ''),
    clusterName,
    thirdPartyCode: strOrNull(credenciada.codigo),
    nodeCode: strOrNull(node.codigo),
    soTypeId: strOrNull(tipoOs.id),
    soTypeDescription: strOrNull(tipoOs.resumoTipoOs) ?? strOrNull(tipoOs.descricao),
    customerCode: strOrNull(contrato.codigo),
    customerName: strOrNull(contrato.nomeTitular),
    addressCode: strOrNull(endereco.codigo),
    addressLine: strOrNull(endereco.logradouro),
    addressCity: strOrNull(endereco.cidade),
    addressLat: numOrNull(endereco.latitude),
    addressLng: numOrNull(endereco.longitude),
    statusCode: String(status.id ?? ''),
    statusDescription: String(status.descricao ?? ''),
    requestedAt: parseIClassDate(raw.dataSolicitacao),
    scheduledFor: parseIClassDate(raw.dataAgendamento),
    availableAt: parseIClassDate(raw.dataDisponibilidade),
    serviceStartedAt: parseIClassDate(raw.dataInicioAtendimento),
    serviceEndedAt: parseIClassDate(raw.dataFimAtendimento),
    resultCodeName: strOrNull(raw.motivoFechamento),
    closedByLogin: strOrNull(alteradoPor.login),
    closedByName: strOrNull(alteradoPor.nome),
    closeLatitude: numOrNull(coords.latitude),
    closeLongitude: numOrNull(coords.longitude),
    closeGpsAt: parseIClassDate(coords.dataRegistro),
    billingAmount: numOrNull(raw.valorCobranca),
    technicianNote: strOrNull(raw.obsEquipe),
    internalNote: strOrNull(raw.obs),
    commentaryLog: strOrNull(raw.comentario),
    teamLogin: strOrNull(equipe.login),
    teamTechnicianName: strOrNull(equipe.tecnico),
    teamPhone: strOrNull(equipe.fone1),
    teamEmail: strOrNull(equipe.email),
    iclassCreatedAt: parseIClassDate(criadoPor.data),
    iclassUpdatedAt: parseIClassDate(alteradoPor.data),
    rawDetail: raw,
  };
}

export function parseHistoryEntry(raw: Record<string, unknown>): SoStatusHistoryEntry {
  const statusOS = obj(raw.statusOS);
  const equipe = obj(raw.equipeDTO);
  return {
    iclassOsStatusId: String(raw.osStatusId ?? ''),
    occurredAt: parseIClassDate(raw.data),
    statusCode: String(statusOS.codigo ?? ''),
    statusDescription: String(statusOS.descricao ?? ''),
    durationMinutes: numOrNull(raw.tempoStatus),
    teamLogin: strOrNull(equipe.login),
    commentary: strOrNull(raw.comentario),
  };
}

export function parseChecklist(raw: Record<string, unknown>): SoChecklist {
  const perguntas = Array.isArray(raw.perguntas) ? (raw.perguntas as Record<string, unknown>[]) : [];
  return {
    iclassSurveyId: String(raw.pesquisaId ?? ''),
    surveyAt: parseIClassDate(raw.dataPesquisa),
    answers: perguntas.map((p, i) => {
      const r = obj(p.resposta);
      const questionType = String(r.tipoPergunta ?? '');
      return {
        questionId: p.pesqPerguntaId != null ? String(p.pesqPerguntaId) : null,
        questionText: String(p.pergunta ?? ''),
        questionType,
        answerOrder: numOrNull(r.ordem) ?? i,
        answerText: strOrNull(r.resposta),
        photoMissing: questionType === 'Foto',
        photoUrl: null, // API v2 is photo-blind; set later by the SEAM correlation
      };
    }),
  };
}

export function parseMaterial(raw: Record<string, unknown>): SoMaterial {
  return {
    iclassOsMaterialId: String(raw.id ?? raw.osMaterialId ?? ''),
    materialCode: strOrNull(raw.codigo ?? raw.materialCode),
    materialDescription: strOrNull(raw.descricao ?? raw.materialDescription),
    qty: numOrNull(raw.quantidade ?? raw.qty) ?? 0,
    unitValue: numOrNull(raw.valorUnitario ?? raw.unitValue),
    totalValue: numOrNull(raw.valorTotal ?? raw.totalValue),
  };
}

export function parseEquipmentEvent(raw: Record<string, unknown>): SoEquipmentEvent {
  return {
    occurredAt: parseIClassDate(raw.data ?? raw.occurredAt),
    type: strOrNull(raw.tipo ?? raw.type),
    serialNumber: strOrNull(raw.numeroSerie ?? raw.serialNumber ?? raw.sn),
    mac: strOrNull(raw.mac),
    patrimonialNo: strOrNull(raw.patrimonio ?? raw.patrimonialNo),
    modelDescription: strOrNull(raw.modelo ?? raw.modelDescription),
  };
}

export function parseResultCode(raw: Record<string, unknown>, soTypeId: string | null): IClassResultCodeDescriptor {
  return {
    soTypeId,
    code: String(raw.codigo ?? '').trim(),
    type: String(raw.tipo ?? '').trim(),
  };
}
