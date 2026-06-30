import dotenv from 'dotenv';
import { parseIntervalMs } from './parseIntervalMs';
dotenv.config();

const REQUIRED_VARS = [
  'SPLYNX_API_URL',
  'SPLYNX_API_KEY',
  'SPLYNX_API_SECRET',
  'JWT_SECRET',
  'PORT',
] as const;

function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in all required values.');
    process.exit(1);
  }
}

validateEnv();

export const config = {
  splynxApiUrl: process.env.SPLYNX_API_URL as string,
  splynxApiKey: process.env.SPLYNX_API_KEY as string,
  splynxApiSecret: process.env.SPLYNX_API_SECRET as string,
  jwtSecret: process.env.JWT_SECRET as string,
  port: parseInt(process.env.PORT as string, 10),

  /**
   * Auth-hardening (SDD #6a). cookieSecure is decoupled from NODE_ENV (prod runs
   * NODE_ENV=development, so the old `secure: NODE_ENV==='production'` was always
   * false). PROD MUST set COOKIE_SECURE=true. corsOrigin replaces the hardcoded
   * localhost origin.
   */
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // || (not ??) so an empty env string from an unset CI secret falls back to the default.
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  /**
   * Gestión Real read-only mirror sync. Opt-in: the whole feature stays dark
   * unless GR_SYNC_ENABLED=true, so the rest of the app boots and runs exactly
   * as before when it's off (no required vars, no scheduler started).
   */
  gestionReal: {
    enabled: process.env.GR_SYNC_ENABLED === 'true',
    baseUrl: process.env.GR_BASE_URL ?? 'https://api.gestionreal.com.ar/',
    cuit: process.env.GR_CUIT ?? '',
    secret: process.env.GR_SECRET ?? '',
    // || (not ??) so an empty env string from an unset CI secret falls back to the default.
    intervalMs: parseInt(process.env.GR_SYNC_INTERVAL_MS || '180000', 10),
    // estado codes to sync — full universe by default:
    // 1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja.
    estados: (process.env.GR_SYNC_ESTADOS || '1,2,3,4,6').split(',').map(s => s.trim()).filter(Boolean),
    // Balance refresh settings
    /** Minutes before a debtor's balance is considered stale and triggers on-demand refresh. */
    balanceStaleTtlMinutes: parseInt(process.env.BALANCE_STALE_TTL_MINUTES || '60', 10),
    /** Max ms for on-demand GR balance request before falling back to stored value. */
    balanceRefreshTimeoutMs: parseInt(process.env.BALANCE_REFRESH_TIMEOUT_MS || '4000', 10),
    /** Interval (ms) between batch debtor balance refresh runs (default: 1h). */
    balanceBatchIntervalMs: parseInt(process.env.GR_BALANCE_BATCH_INTERVAL_MS || '3600000', 10),
  },

  /**
   * IClass Field Service integration. Opt-in: credentials are NOT required at
   * boot (no fail-fast). The on/off state lives in the FeatureFlag table
   * ("iclass-integration"); these are just the upstream credentials/config the
   * adapter needs when the flag is turned on.
   */
  iclass: {
    baseUrl: process.env.ICLASS_BASE_URL ?? 'https://api-v2.iclass.com.br',
    username: process.env.ICLASS_USERNAME ?? '',
    password: process.env.ICLASS_PASSWORD ?? '',
    thirdPartyId: process.env.ICLASS_THIRD_PARTY_ID ?? '',
  },

  /**
   * IClass SEAM portal (fs2.iclass.com.br) — closure-loop photo scraper. The API
   * v2 is photo-blind; the portal HTML is the only source for checklist photo
   * URLs and the signature. Opt-in like `iclass` (no fail-fast at boot).
   */
  iclassPortal: {
    baseUrl: process.env.ICLASS_PORTAL_BASE_URL ?? 'https://fs2.iclass.com.br',
    user: process.env.ICLASS_PORTAL_USER ?? '',
    password: process.env.ICLASS_PORTAL_PASSWORD ?? '',
  },

  /**
   * Device-photo OCR (closure loop F4). Local Ollama vision model by default
   * (zero per-image cost, photos stay in infra). Opt-in via ICLASS_OCR_ENABLED.
   */
  ocr: {
    enabled: process.env.ICLASS_OCR_ENABLED === 'true',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    model: process.env.OCR_MODEL ?? 'gemma3:12b',
    /** Per-image inference timeout (ms). Abort → soft-fail to manual review. */
    timeoutMs: parseInt(process.env.OCR_TIMEOUT_MS || '120000', 10),
  },

  /**
   * AI installation audit (closure loop F6). Multimodal Ollama vision model.
   * El gate (on/off) ya NO es el env: lo controla el feature flag DB-backed
   * `iclass-audit` (default OFF, toggleable en runtime desde la UI). El env
   * solo provee la config del modelo Ollama.
   */
  audit: {
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    model: process.env.AUDIT_MODEL ?? 'qwen2.5vl:7b',
    timeoutMs: parseInt(process.env.AUDIT_TIMEOUT_MS || '180000', 10),
  },

  /**
   * UISP NMS mirror sync. Opt-in: absent env → client null → scheduler skip with log.
   * NOT in REQUIRED_VARS — no fail-fast at boot.
   * UISP uses a self-signed internal TLS cert (rejectUnauthorized: false in adapter).
   */
  uisp: {
    baseUrl: process.env.UISP_BASE_URL ?? '',
    token: process.env.UISP_TOKEN ?? '',
  },

  /**
   * RouterOS API — PPPoE management (épico pppoe-service, Fase B). El mismo usuario para los 13
   * routers; la IP/puerto salen del `NasServer`. Server-side: NUNCA viaja al browser.
   * Opt-in (NO fail-fast, patrón iclass/uisp): si faltan, el RouterOsGateway falla al conectar
   * con un error claro, pero el resto de la app arranca igual.
   */
  router: {
    apiUser: process.env.ROUTER_API_USER ?? '',
    apiPassword: process.env.ROUTER_API_PASSWORD ?? '',
    /**
     * Profile de REDUCCIÓN para el corte de deudores (Fase C). El secret PPPoE pasa a este
     * profile al `reduce`; el comercial se conserva en la DB para restaurar. Confirmado en Phase 0:
     * `IP-REDUCCION` ya existe en los routers. Configurable por si cambia el nombre.
     */
    reducedProfile: process.env.ROUTER_REDUCED_PROFILE ?? 'IP-REDUCCION',
    /**
     * Corte masivo (Fase C). Calibrables sin recompilar (decisión: arrancar conservador).
     * - bulkThrottleMs: pausa entre ops del MISMO router (1 carril por maestro) — resiliencia > velocidad.
     * - bulkConcurrency: cuántos routers procesar en paralelo.
     */
    bulkThrottleMs: parseInt(process.env.ROUTER_BULK_THROTTLE_MS || '300', 10),
    bulkConcurrency: parseInt(process.env.ROUTER_BULK_CONCURRENCY || '8', 10),
    /**
     * SSH al router para LEER las IPs asignadas (allocator / FindFreeIp). La API node-routeros
     * (8728) CUELGA contra RouterOS 7.x al hacer `/ppp secret print`; SSH responde al instante.
     * Opt-in (NO fail-fast, patrón apiUser/uisp): si falta la key, `listAssignedIps` falla al
     * conectar con RouterUnreachableError (la ruta lo mapea a 502), pero la app arranca igual.
     * - sshKey: PEM completo de la private key (ROUTER_SSH_KEY). undefined si no está seteada.
     * - sshUser/sshPort: mismas credenciales para los 13 routers; el host sale del NasServer.
     */
    sshKey: process.env.ROUTER_SSH_KEY || undefined,
    sshUser: process.env.ROUTER_SSH_USER || 'ronald',
    sshPort: parseInt(process.env.ROUTER_SSH_PORT || '2026', 10),
  },

  /**
   * radius-orchestrator (FreeRADIUS HA, p.ej. http://10.75.0.20:8080) — corte por RADIUS para los
   * NAS ya cutoveados al HA (`nas.type='radius_orchestrator'`). Opt-in (NO fail-fast, patrón router/uisp):
   * si falta `baseUrl`, el HttpRadiusOrchestratorGateway falla al USARSE con error claro, pero la app
   * arranca igual y los NAS MK-directo siguen cortando. El bearer token es SERVER-SIDE: nunca al browser.
   */
  orchestrator: {
    baseUrl: process.env.ORCHESTRATOR_BASE_URL ?? '',
    token: process.env.ORCHESTRATOR_API_TOKEN ?? '',
    timeoutMs: parseInt(process.env.ORCHESTRATOR_TIMEOUT_MS || '6000', 10),
  },

  /**
   * RADIUS auth ingest (radpostauth) — frescura del scheduler de errores de auth.
   * Configurable sin redeploy via RADIUS_AUTH_INGEST_INTERVAL_MS para poder bajar/subir
   * el ritmo si el orchestrator se carga. Default 60_000 (1 min). Mínimo de seguridad
   * 15_000 (15s) para NO martillar al orchestrator; máximo 86_400_000 (24h) para que un
   * fat-finger por confusión de unidades no haga que setInterval dispare cada 1ms (techo
   * < TIMEOUT_MAX de Node). Valor inválido/ausente → default; fuera de rango → se clampa.
   * NUNCA tumba el boot (no fail-fast): el scheduler es opt-in y best-effort.
   */
  radiusAuthIngest: {
    intervalMs: parseIntervalMs(process.env.RADIUS_AUTH_INGEST_INTERVAL_MS, {
      default: 60_000,
      min: 15_000,
      max: 86_400_000,
    }),
  },

  /**
   * airOS SSH — inspección de antenas Ubiquiti airOS para detección de equipos del cliente.
   * Opt-in (NO fail-fast): si faltan credenciales, el gateway falla al USARSE con
   * AirOsUnreachableError (200 con warning), pero el resto de la app arranca igual.
   *
   * - AIROS_SSH_USER: usuario SSH de la antena (default 'ubnt').
   * - AIROS_SSH_PASSWORDS: contraseñas a probar (comma-separated). En producción se
   *   leen de variables de entorno — NO hardcodear credenciales en el código.
   *   Si está vacío, se intentará con 'ubnt' como única contraseña.
   */
  airos: {
    user: process.env.AIROS_SSH_USER ?? 'ubnt',
    passwords: (process.env.AIROS_SSH_PASSWORDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  /**
   * PPPoE ingest — patrones de exclusión de usernames placeholder.
   * Los usernames del RADIUS que matcheen alguno de estos patrones se descartan durante el
   * ingest (IngestPppoeFromNas) y se filtran del listado de huérfanos (ListUnassignedPppoe).
   * Formato: comma-separated list de patrones regex. Case-insensitive.
   * Default: `^accesosur\d+$` (usuarios internos del ISP que no son clientes reales).
   */
  pppoe: {
    ingestExcludePatterns: (process.env.PPPOE_INGEST_EXCLUDE_PATTERN ?? '^accesosur\\d+$')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(p => new RegExp(p, 'i')),
  },

  /**
   * External API v1 — machine-to-machine, API-key auth. Opt-in (NO fail-fast at boot).
   * If EXTERNAL_API_KEY is not set (or empty), the external API is closed — middleware
   * returns 401 for all requests. Pattern: iclass/uisp (process.env.X ?? '').
   */
  externalApi: {
    apiKey: process.env.EXTERNAL_API_KEY ?? '',
  },

  /**
   * Network audit — BRAS NE8000 configuration.
   * FIX8: IP del NE8000 inyectable via env var (NE8000_NAS_IP) en lugar de hardcodeada
   * en el use case (application layer). Se inyecta al construir ListNe8000PppoeAudit en app.ts.
   * Default '10.75.0.30' confirmado en Phase 0 (2026-06-22).
   */
  networkAudit: {
    ne8000NasIp: process.env.NE8000_NAS_IP ?? '10.75.0.30',
  },

  /**
   * MinIO (S3-compatible) — storage de las fotos de tareas (feature task-photos).
   * OPT-IN, NO fail-fast (mismo patrón que iclass/uisp/router): si faltan las env,
   * quedan strings vacíos / defaults y el BE ARRANCA IGUAL. La feature de fotos
   * degrada (los endpoints fallan al usarse contra un MinIO inalcanzable) pero el
   * resto del sistema levanta normal. Hoy en prod las MINIO_* todavía NO están
   * seteadas: una integración externa faltante NO debe tumbar el boot.
   */
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? '',
    // D4: parse robusto — un MINIO_PORT no numérico/vacío cae a 9000 (NaN NUNCA llega al
    // Client; el guard lazy de MinioFileStorage protege igual, pero no producimos NaN acá).
    port: (() => {
      const p = Number(process.env.MINIO_PORT);
      return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 9000;
    })(),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
    bucket: process.env.MINIO_BUCKET ?? 'task-photos',
  },
};
