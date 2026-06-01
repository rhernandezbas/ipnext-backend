import dotenv from 'dotenv';
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
};
