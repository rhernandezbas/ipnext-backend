// One-off backfill of Service.address/lat/lng from GR contracts.
// Run inside the backend container (has pg, axios, GR_* + DATABASE_URL env):
//   docker exec -d ipnext-new-backend node /tmp/backfill-svc.js  (logs to /tmp/backfill-svc.log)
// Groups services by grClienteId → 1 GR `contrato` call per client.
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CUIT = process.env.GR_CUIT;
const SECRET = process.env.GR_SECRET;
const BASE = process.env.GR_BASE_URL || 'https://api.gestionreal.com.ar/';

function grAuth() {
  const f = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const pwd = crypto.createHash('md5').update(`${CUIT}${SECRET}${f}`).digest('hex');
  return { username: CUIT, password: pwd };
}
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v) {
  if (v === null || v === undefined || v === false) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

(async () => {
  // distinct GR clients that have GR-sourced services
  const clientsRes = await pool.query(
    `SELECT DISTINCT c."grClienteId" AS gid
     FROM "Service" s JOIN "Client" c ON c.id = s."clientId"
     WHERE s."grContratoId" IS NOT NULL AND c."grClienteId" IS NOT NULL`
  );
  const ids = clientsRes.rows.map(r => r.gid);
  console.log(`[backfill-svc] ${ids.length} GR clients with services to process`);

  let processed = 0, updated = 0, errors = 0;
  for (const gid of ids) {
    try {
      const { data } = await axios.post(BASE, { action: 'contrato', cli_id: Number(gid), incluye_bajas: 'S' },
        { auth: grAuth(), headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
      const contratos = Array.isArray(data?.contratos) ? data.contratos : [];
      for (const k of contratos) {
        const grId = strOrNull(k.id);
        if (!grId) continue;
        const r = await pool.query(
          `UPDATE "Service" SET address=$1, lat=$2, lng=$3 WHERE "grContratoId"=$4`,
          [strOrNull(k.domicilio), numOrNull(k.lat), numOrNull(k.lng), grId]
        );
        updated += r.rowCount;
      }
    } catch (e) {
      errors++;
    }
    processed++;
    if (processed % 200 === 0) console.log(`[backfill-svc] ${processed}/${ids.length} clients, ${updated} services updated, ${errors} errors`);
  }
  console.log(`[backfill-svc] DONE. clients=${processed} servicesUpdated=${updated} errors=${errors}`);
  await pool.end();
})().catch(e => { console.error('[backfill-svc] FATAL', e.message); process.exit(1); });
