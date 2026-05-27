import pg from 'pg';
import { DistributedLock } from '@domain/ports/DistributedLock';

/**
 * Distributed lock backed by Postgres session-level advisory locks.
 *
 * WHY a dedicated pg.Client instead of the Prisma pool
 * -------------------------------------------------------
 * Session advisory locks (pg_try_advisory_lock / pg_advisory_unlock) are
 * tied to the *connection* that acquired them. In a connection pool the
 * connection that runs tryAcquire might differ from the one that runs
 * release — causing the unlock to silently fail (or unlock the wrong key).
 *
 * To avoid that, this adapter keeps a single, long-lived pg.Client that
 * is reused for every acquire/release on the same key. The client is
 * connected lazily on the first tryAcquire call and intentionally never
 * disconnected while the process runs (the OS reclaims connections on
 * process exit).
 *
 * Trade-off / crash behaviour
 * ---------------------------
 * If the process holding the lock crashes (or the dedicated connection is
 * dropped), Postgres automatically releases all session advisory locks
 * held by that connection. There is NO stale-lock scenario to worry about
 * as long as the pg.Client connection dies with the process — which it
 * always does, because the socket closes.
 *
 * The only edge case is a network partition where the Postgres server
 * considers the connection dead before the client does. In practice, with
 * TCP keepalives and a healthy network, this window is <60s and acceptable
 * for a background sync job.
 */
export class PgAdvisoryLock implements DistributedLock {
  private client: pg.Client;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(connectionString?: string) {
    this.client = new pg.Client({
      connectionString: connectionString ?? process.env.DATABASE_URL,
    });

    // Forward unexpected disconnects so errors aren't swallowed silently.
    this.client.on('error', (err) => {
      console.error('[PgAdvisoryLock] pg client error:', err.message);
      this.connected = false;
      this.connecting = null;
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;

    // Prevent concurrent connect() calls when multiple acquires arrive at once.
    if (!this.connecting) {
      this.connecting = this.client.connect().then(() => {
        this.connected = true;
        this.connecting = null;
      });
    }

    await this.connecting;
  }

  async tryAcquire(key: string): Promise<boolean> {
    await this.ensureConnected();
    const result = await this.client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1))',
      [key],
    );
    return result.rows[0].pg_try_advisory_lock;
  }

  async release(key: string): Promise<void> {
    if (!this.connected) return; // Nothing to release if we never connected.
    await this.client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
  }
}
