// Piped into the backend container via: docker exec -i ipnext-new-backend node < this
// Read-only unless CONFIRM=YES is set in the exec env. Uses pg + the container's DATABASE_URL.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function counts(label) {
  const c = await pool.query('SELECT count(*)::int AS n FROM "Client"');
  const s = await pool.query('SELECT count(*)::int AS n FROM "Service"');
  const i = await pool.query('SELECT count(*)::int AS n FROM "Invoice"');
  console.log(`[${label}] clients=${c.rows[0].n} services=${s.rows[0].n} invoices=${i.rows[0].n}`);
}

(async () => {
  await counts('BEFORE');
  if (process.env.CONFIRM !== 'YES') {
    console.log('DRY RUN — set CONFIRM=YES to delete. Nothing changed.');
    return;
  }
  const d = await pool.query('DELETE FROM "Client"');
  console.log(`Deleted ${d.rowCount} clients (cascade to services/invoices/logs).`);
  await counts('AFTER');
})()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
