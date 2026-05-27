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
    // estado codes to sync — default 1=Activo, 2=Deudor.
    estados: (process.env.GR_SYNC_ESTADOS || '1,2').split(',').map(s => s.trim()).filter(Boolean),
  },
};
