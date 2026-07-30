import dotenv from 'dotenv';
import { parseIntervalMs } from './parseIntervalMs';
import { parsePositiveInt } from './parsePositiveInt';
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
   * Login rate limit (SDD #6a + login-ratelimit-nat). El limiter keyea por IP+username;
   * estos controlan el techo por (IP, usuario) y la ventana. Configurables por env para
   * ajustar sin recompilar si una oficina con muchos usuarios necesita más holgura.
   * windowMs: clamp [1min, 24h] vía parseIntervalMs (default 15min). limit default 20.
   */
  loginRateLimit: {
    // limit ENDURECIDO (review W1): un secret mal seteado a "0"/"-5" daría limit<=0 →
    // 429 en el 1er request → outage TOTAL (peor que el incidente). NaN/0/negativo → 20.
    // Mismo patrón defensivo que MINIO_PORT abajo. parseIntervalMs ya endurece windowMs.
    limit: (() => {
      const n = parseInt(process.env.LOGIN_RATE_LIMIT || '', 10);
      return Number.isInteger(n) && n > 0 ? n : 20;
    })(),
    windowMs: parseIntervalMs(process.env.LOGIN_RATE_WINDOW_MS, {
      default: 15 * 60 * 1000,
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
    }),
  },

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
   * ai-assistant-multiagent — asistente IA conversacional sobre Chatwoot.
   *
   * ⚠️ Sin `apiKey` el adapter degrada a no-op (RUN-1): el motor no lanza, no responde, y
   * queda auditado. **Deliberadamente NO es fail-fast como el resto de config.ts** — un
   * deploy sin la key debe dejar el bot mudo, jamás impedir que levante el server. El
   * asistente es una feature opcional detrás de un flag; la mensajería, la facturación y el
   * RADIUS no pueden caerse porque falte una credencial de IA.
   *
   * LECCIÓN (incidente ORCHESTRATOR_BASE_URL, 2026-06-20): los gates mockean HTTP y NO cazan
   * una env var faltante en prod. Setear con `gh secret set DEEPSEEK_API_KEY` + la línea
   * `-e DEEPSEEK_API_KEY` en el step `Deploy container` de `deploy.yml`.
   */
  assistant: {
    /** API oficial de DeepSeek. Los datos van a servidores en China — de ahí la regla de cero PII. */
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    timeoutMs: parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '20000', 10),
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
   * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · MEDIA-3) — barrido de reintento de
   * `ChatMessageAttachment` (`ChatMediaDownloadScheduler`). Default 120_000 (~2min, decisión
   * F del proposal). Mismo contrato defensivo que radiusAuthIngest: piso 15s, techo 24h,
   * inválido/ausente → default. NUNCA tumba el boot: opt-in, gateado por el feature flag
   * 'chat-media-download' (dark by default).
   */
  chatMediaDownload: {
    intervalMs: parseIntervalMs(process.env.CHAT_MEDIA_DOWNLOAD_INTERVAL_MS, {
      default: 120_000,
      min: 15_000,
      max: 86_400_000,
    }),
  },

  /**
   * PPPoE auto-move watcher (pppoe-move-nas W2) — frescura del tick de detección de mismatches
   * NAS real vs asignado. Configurable sin redeploy via AUTO_MOVE_INTERVAL_MS. Default 120_000
   * (2 min, decisión de design D4). Mismo contrato defensivo que radiusAuthIngest: piso 15s
   * (no martillar al orchestrator), techo 24h (fat-finger de unidades), inválido/ausente →
   * default. NUNCA tumba el boot (S7.2): el scheduler es opt-in y el ON/OFF real va por el
   * feature flag 'pppoe-auto-move' (DB, chequeado por tick).
   */
  pppoeAutoMove: {
    intervalMs: parseIntervalMs(process.env.AUTO_MOVE_INTERVAL_MS, {
      default: 120_000,
      min: 15_000,
      max: 86_400_000,
    }),
    /**
     * D-W2.5 item 1 (C3) — circuit breaker: mismatches del tick > umbral ⇒ tick ABORTADO
     * entero, sin mover nada (huele a error de inventario: NAS duplicado, nasIpAddress mal
     * editada). Parse seguro: inválida/0/negativa → default 25 (un fat-finger no deja el
     * breaker en "abortar siempre"). JAMÁS tumba el boot.
     */
    abortThreshold: parsePositiveInt(process.env.AUTO_MOVE_ABORT_THRESHOLD, {
      default: 25,
      max: 100_000,
    }),
    /**
     * D-W2.5 item 1 (C3) — cap de moves por tick: a lo sumo N moves; el resto queda `deferred`
     * para el próximo tick (el mismatch persiste y se re-detecta). Default 10.
     */
    maxMovesPerTick: parsePositiveInt(process.env.AUTO_MOVE_MAX_MOVES_PER_TICK, {
      default: 10,
      max: 100_000,
    }),
    /**
     * D-W2.5 item 2 (C2a) — cooldown anti-revert: si el último evento 'moved' del username
     * (CUALQUIER trigger) es más nuevo que esto, el watcher NO mueve (evita deshacer un move
     * manual recién hecho cuya sesión vieja sigue viva por un kick fallido). Default 10 min.
     */
    cooldownMs: parseIntervalMs(process.env.AUTO_MOVE_COOLDOWN_MS, {
      default: 600_000,
      min: 15_000,
      max: 86_400_000,
    }),
    /**
     * D-W2.5 item 4 (C1) — freshness de la sesión ganadora: sin actividad más reciente que
     * esto NO se actúa (outcome skipped_stale_session). El wire del GET /sessions del
     * orchestrator NO trae lastUpdate/acctupdatetime → el gate usa startedAt (fallback del
     * design). Default 72h; piso 1h (un valor ínfimo apagaría el watcher entero).
     */
    sessionFreshnessMs: parseIntervalMs(process.env.AUTO_MOVE_SESSION_FRESHNESS_MS, {
      default: 259_200_000,
      min: 3_600_000,
      max: 2_147_483_647,
    }),
  },

  /**
   * radius-session-autocure BE-1 (REQ-CURE-1/2/4) — watcher AutoCureStuckSessions. El ON/OFF
   * real vive en el feature flag 'radius-auto-cure' (tabla FeatureFlag, seed OFF, chequeado
   * POR TICK); estas envs solo CALIBRAN el tick. Parse seguro en todas: inválida/ausente →
   * default, JAMÁS tumban el boot (mismo contrato defensivo que pppoeAutoMove/radiusAuthIngest).
   */
  radiusAutoCure: (() => {
    const intervalMs = parseIntervalMs(process.env.RADIUS_AUTO_CURE_INTERVAL_MS, {
      default: 60_000,
      min: 15_000,
      max: 86_400_000,
    });
    /**
     * REQ-CURE-6/D6 — PISO DURO 20 min (validado: interim 600s clavado, 0 sesiones sanas >30min
     * sin interim, <20min = falsos positivos masivos). Un fat-finger NO puede bajar este umbral
     * por debajo de la evidencia — a diferencia de otros pisos, este NO es negociable.
     */
    const staleMs = parseIntervalMs(process.env.RADIUS_AUTO_CURE_STALE_MS, {
      default: 1_200_000,
      min: 1_200_000,
      max: 86_400_000,
    });
    /** Enmienda fast-path — piso 2 min: evita curar por una ráfaga transitoria de redial. */
    const persistenceMs = parseIntervalMs(process.env.RADIUS_AUTO_CURE_PERSISTENCE_MS, {
      default: 300_000,
      min: 120_000,
      max: 86_400_000,
    });
    /** Enmienda fast-path — piso 30s: exige que el cliente SIGA intentando (rejects recientes). */
    const recencyMs = parseIntervalMs(process.env.RADIUS_AUTO_CURE_REJECT_RECENCY_MS, {
      default: 120_000,
      min: 30_000,
      max: 86_400_000,
    });
    /**
     * S7.4 — coherencia de ventanas: el lookback DEBE poder observar la ventana completa del
     * fast path (persistencia + recencia), si no un reject que arrancó la persistencia queda
     * fuera del barrido antes de completarse. Clamp hacia arriba + WARN; NUNCA tumba el boot.
     */
    const minCoherentLookbackMs = persistenceMs + recencyMs;
    const rawLookbackMs = parseIntervalMs(process.env.RADIUS_AUTO_CURE_LOOKBACK_MS, {
      default: 900_000,
      min: 15_000,
      max: 86_400_000,
    });
    let lookbackMs = rawLookbackMs;
    if (lookbackMs <= minCoherentLookbackMs) {
      lookbackMs = minCoherentLookbackMs + 60_000;
      console.warn(
        `[config] RADIUS_AUTO_CURE_LOOKBACK_MS (${rawLookbackMs}ms) <= PERSISTENCE_MS+RECENCY_MS ` +
        `(${minCoherentLookbackMs}ms) — clampado a ${lookbackMs}ms (S7.4, el fast path necesita ver su ventana completa).`,
      );
    }

    return {
      intervalMs,
      lookbackMs,
      staleMs,
      persistenceMs,
      recencyMs,
      /** Breaker: candidatos únicos > umbral ⇒ ABORT del tick entero. Default 20. */
      abortThreshold: parsePositiveInt(process.env.RADIUS_AUTO_CURE_ABORT_THRESHOLD, {
        default: 20,
        max: 100_000,
      }),
      /** Cap de curas por tick; el resto queda deferred. Default 5. */
      maxPerTick: parsePositiveInt(process.env.RADIUS_AUTO_CURE_MAX_PER_TICK, {
        default: 5,
        max: 100_000,
      }),
      /**
       * Cure-throttle anti-flapping: una cura por username cada COOLDOWN_MS máximo. Default 30min.
       * LOW-1 (review adversarial): piso subido de 60s a 5min — 60s combinado con un flappingMax
       * alto permitía "cured cada ~60s" (anti-kick-loop débil); 5min es un piso más sano.
       */
      cooldownMs: parseIntervalMs(process.env.RADIUS_AUTO_CURE_COOLDOWN_MS, {
        default: 1_800_000,
        min: 300_000,
        max: 86_400_000,
      }),
      /**
       * >= N curas del username en 24h (ventana fija) ⇒ flagged_flapping. Default 3.
       * LOW-1 (review adversarial): techo bajado de 1000 a 20 — combinado con el piso viejo de
       * cooldownMs (60s), un techo de 1000 delataba el flapping recién a las ~16h de curas cada
       * 60s, demasiado tarde para cortar un kick-loop real. 20 es un techo razonable.
       */
      flappingMax: parsePositiveInt(process.env.RADIUS_AUTO_CURE_FLAPPING_MAX, {
        default: 3,
        max: 20,
      }),
    };
  })(),

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
   * NOC Alerts Hub (noc-alerts-hub, Fase A) — machine-to-machine ingest keys,
   * ONE per fuente (Grafana webhook / colector fibra Rust), so rotating one
   * never forces rotating the other (design.md "POST /api/alerts/ingest canónico
   * + /ingest/grafana"). `createApiKeyMiddleware(key)` fails closed (401) when a
   * key is empty — same contract as `externalApi.apiKey` above.
   *
   * DEVIATION from tasks.md A23 ("fail-fast al import"): kept OPT-IN instead of
   * added to REQUIRED_VARS. REQUIRED_VARS only holds the original 5 vars — every
   * integration key added since (externalApi.apiKey, CHATWOOT_*, TWILIO_*,
   * SMARTOLT_*, ...) follows the SAME opt-in pattern (empty default, feature
   * degrades/fails-closed at request time, boot never dies). Adding these two to
   * REQUIRED_VARS would process.exit(1) on every existing deployment/CI run that
   * doesn't set them yet (none currently do) — that is the OPPOSITE of "dark
   * launch". Fail-closed-at-request achieves the same security intent (no key →
   * no access) without an unannounced boot-breaking change.
   */
  alerts: {
    grafanaIngestKey: process.env.GRAFANA_INGEST_KEY ?? '',
    fiberIngestKey: process.env.FIBER_INGEST_KEY ?? '',

    /**
     * Fase D (`noc-alert-telegram`) — bot de Telegram bidireccional del hub.
     *
     * DEVIATION from tasks.md D14 ("fail-fast de telegramBotToken/
     * telegramWebhookSecret al import"): kept OPT-IN instead, SAME reasoning
     * as the DEVIATION already documented above for grafanaIngestKey/
     * fiberIngestKey, now reinforced by the Fase D convivencia contract
     * itself (design.md "Restricción dura de convivencia" + the explicit task
     * instruction: "opt-in, empty default — los secrets se setean en el
     * cutover"). The flag `noc-alerts-telegram-send` is seeded OFF (Fase A
     * migration) for the ENTIRE convivencia window — with it OFF,
     * `TelegramBotGateway` is never invoked regardless of whether these are
     * set. Fail-fasting on an empty token/secret would process.exit(1) on
     * every CURRENT deployment (none set these yet) for a channel that's
     * intentionally dark — the opposite of dark-launch. With the flag ON and
     * an empty token, `TelegramBotGateway.notify` fails best-effort (caught,
     * logged, returns null) instead of taking the boot down; an empty
     * `telegramWebhookSecret` makes `createTelegramSecretMiddleware` fail
     * CLOSED (401 on every request) — same "no key → no access" intent as
     * `externalApi.apiKey`, achieved at request-time, not at boot.
     */
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    /** Chat/canal NOC de destino de los `notify()` salientes. */
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    /** Compara contra `X-Telegram-Bot-Api-Secret-Token` en `POST /telegram/webhook`. */
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',

    /**
     * alerts-ingest-ratelimit (fix, incidente en vivo 2026-07-26) — límite del
     * rate limiter DEDICADO de `POST /ingest/:source` (`createIngestRateLimiter`,
     * rateLimiters.ts). Reusar el limiter del API externo (30 req/60s) ya
     * rebotaba alertas reales del colector de fibra (~29 req/ciclo, al filo de
     * 30). Default 600/60s — cubre un incidente grande (hasta 600 ONUs
     * degradando en un mismo ciclo) sin dejar la ruta sin techo. Configurable
     * por env por si el tamaño del colector/incidente cambia sin redeploy.
     * Mismo patrón defensivo que `loginRateLimit.limit`: un secret mal seteado
     * ("0"/"-5"/no-numérico) no puede tumbar la ingesta con un 429 inmediato
     * en el 1er request → NaN/0/negativo cae al default (600), nunca a 0.
     */
    ingestRateLimit: {
      // Se usa `parsePositiveInt` (helper ya existente y testeado) en vez de un
      // `parseInt` propio: `parseInt` CORTA en el primer no-dígito, así que
      // `"1e9"` daría limit=1 → 429 desde el 2do request = outage de la
      // ingesta (hallazgo del review adversarial). Además agrega el techo que
      // el parseo manual no tenía.
      limit: parsePositiveInt(process.env.ALERTS_INGEST_RATE_LIMIT, {
        default: 600,
        min: 1,
        max: 100_000,
      }),
      windowMs: parseIntervalMs(process.env.ALERTS_INGEST_RATE_WINDOW_MS, {
        default: 60 * 1000,
        min: 1_000,
        max: 60 * 60 * 1000,
      }),
    },
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

  /**
   * Chatwoot (messaging-inbox F1) — Application API para el inbox de WhatsApp. Opt-in
   * (NO en REQUIRED_VARS, patrón `iclass`): si faltan las credenciales, `HttpChatwootGateway`
   * igual se construye pero cualquier llamada falla con `ChatwootUnavailableError` (503) —
   * no hay "flag ready" tipo Gestión Real acá, decisión ya cerrada en design.md §9/§6:
   * config estática, el boot NUNCA falla por esto.
   */
  chatwoot: {
    baseUrl: process.env.CHATWOOT_BASE_URL ?? '',
    accountId: process.env.CHATWOOT_ACCOUNT_ID ?? '',
    apiToken: process.env.CHATWOOT_API_TOKEN ?? '',
    inboxId: process.env.CHATWOOT_INBOX_ID ?? '',
    webhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET ?? '',
  },

  /**
   * messaging-bulk (F2, Batch 8) — Twilio Content API, envío directo de
   * templates de WhatsApp (design D2/§9). Opt-in (patrón chatwoot/iclass, NO
   * en REQUIRED_VARS): si faltan las credenciales, `TwilioContentGateway`
   * igual se construye, pero cualquier llamada falla con
   * `TemplateProviderUnavailableError` (503) — el boot NUNCA falla por esto
   * (lección ORCHESTRATOR_BASE_URL: env faltante = 502 en runtime, no 500 al
   * levantar el server). El BE usa SUS PROPIOS secrets (no reusa los del
   * canal Chatwoot `channel_twilio_sms` en runtime).
   */
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
  },

  /**
   * smartolt-provision (K2) — API de SmartOLT (aprovisionamiento de ONUs fibra
   * Huawei). Opt-in (NO fail-fast, patrón ORCHESTRATOR_*): sin baseUrl/token el
   * SmartOltHttpGateway falla AL USARSE con SMARTOLT_NOT_CONFIGURED (503) y las
   * rutas /api/fiber devuelven "feature apagada" limpia — el resto de la app
   * arranca igual. El X-Token es SERVER-SIDE: nunca viaja al browser.
   * - stepPauseMs: pausa entre calls consecutivos del flujo (rate limit 10/s de
   *   SmartOLT). parsePositiveInt: inválido/<=0 → default 2000 (un fat-finger no
   *   puede anular la pausa). Techo 60s (fat-finger de unidades).
   */
  smartolt: {
    baseUrl: process.env.SMARTOLT_BASE_URL ?? '',
    token: process.env.SMARTOLT_API_TOKEN ?? '',
    stepPauseMs: parsePositiveInt(process.env.SMARTOLT_STEP_PAUSE_MS, {
      default: 2000,
      max: 60_000,
    }),
    timeoutMs: parsePositiveInt(process.env.SMARTOLT_TIMEOUT_MS, {
      default: 15_000,
      max: 300_000,
    }),
  },

  /**
   * K3 (fiber-auto-watcher) — watcher full-auto de aprovisionamiento de ONUs fibra.
   * El ON/OFF real vive en el feature flag 'fiber-auto-provision-watcher' (seed OFF,
   * chequeado POR TICK, SEPARADO del flag del wizard); esta env solo CALIBRA el tick.
   * Piso 60s (rate limit SmartOLT 1000/h — un tick por segundo lo fundiría), techo 24h.
   * Parse seguro: inválida/ausente → default 5min, JAMÁS tumba el boot.
   */
  fiberAutoProvision: {
    intervalMs: parseIntervalMs(process.env.FIBER_AUTO_PROVISION_INTERVAL_MS, {
      default: 300_000,
      min: 60_000,
      max: 86_400_000,
    }),
  },

  /**
   * messaging-bulk (F2, Batch 8, SEND-4) — rate limiter proactivo del envío
   * masivo (~80 msg/s en prod, `TokenBucketRateLimiter`). Calibrable SIN
   * redeploy vía env: el límite real del plan Twilio se confirma recién en el
   * gate EN VIVO (Batch 9). `parsePositiveInt`: ausente/inválido/<=0 →
   * default 80 (un fat-finger no puede dejar el rate en 0 = "nunca envía").
   */
  messagingBulk: {
    ratePerSec: parsePositiveInt(process.env.MESSAGING_BULK_RATE_PER_SEC, { default: 80, max: 1000 }),
  },

  /**
   * customer-portal-api (Fase 7, task 7.1) — nombre del area de tickets a la
   * que `CreatePortalTicket` intenta resolver los reclamos creados desde el
   * portal de clientes (design.md "Tickets del portal: defaults por
   * catalogo"). Opt-in / NO fail-fast (mismo patron que el resto de este
   * archivo): si el area configurada no existe en el catalogo real de prod,
   * el use case cae a la PRIMERA area de `list()` — jamas crea una area
   * nueva desde el portal. `||` (no `??`) para que un env vacio seteado por
   * error tambien caiga al default, mismo criterio que `corsOrigin` arriba.
   * Default "Atencion al cliente" (mismo default que
   * DEFAULT_PORTAL_TICKET_AREA_NAME en CreatePortalTicket.ts — no se importa
   * esa constante aca para no acoplar infra->application por un string).
   */
  portal: {
    ticketAreaName: process.env.PORTAL_TICKET_AREA_NAME || 'Atención al cliente',
  },
};
