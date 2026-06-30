/**
 * Unit tests for MinioFileStorage (C1 lazy client, M4 bucket ensure + NoSuchBucket
 * classification, M1 timeout). No real MinIO: a fake client is injected via the
 * `clientFactory` option.
 */
import { Readable } from 'stream';
import { MinioFileStorage, MinioClientLike } from '@infrastructure/adapters/minio/MinioFileStorage';
import { StorageNotConfiguredError } from '@domain/errors/taskAttachment';

const EMPTY_OPTS = {
  endPoint: '',
  port: 0,
  useSSL: false,
  accessKey: '',
  secretKey: '',
  bucket: 'task-photos',
};

const GOOD_OPTS = {
  endPoint: 'minio.local',
  port: 9000,
  useSSL: false,
  accessKey: 'ak',
  secretKey: 'sk',
  bucket: 'task-photos',
};

/** Fake MinIO client whose behaviour each test tunes. */
function makeFakeClient(overrides: Partial<MinioClientLike> = {}): MinioClientLike {
  return {
    putObject: jest.fn(async () => ({ etag: 'x' })),
    getObject: jest.fn(async () => Readable.from([Buffer.from('DATA')])),
    statObject: jest.fn(async () => ({ metaData: { 'content-type': 'image/jpeg' } })),
    removeObject: jest.fn(async () => undefined),
    bucketExists: jest.fn(async () => true),
    makeBucket: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('MinioFileStorage — C1 lazy client', () => {
  it('the constructor does NOT throw with empty/invalid config (boot survives)', () => {
    expect(() => new MinioFileStorage(EMPTY_OPTS)).not.toThrow();
    expect(() => new MinioFileStorage({ ...GOOD_OPTS, port: Number.NaN })).not.toThrow();
  });

  it('save() with empty config throws StorageNotConfiguredError (503), never InvalidEndpoint', async () => {
    const storage = new MinioFileStorage(EMPTY_OPTS);
    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it('get()/delete() with empty config also throw StorageNotConfiguredError', async () => {
    const storage = new MinioFileStorage(EMPTY_OPTS);
    await expect(storage.get('k')).rejects.toBeInstanceOf(StorageNotConfiguredError);
    await expect(storage.delete('k')).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it('NaN port is treated as unconfigured → StorageNotConfiguredError', async () => {
    const storage = new MinioFileStorage({ ...GOOD_OPTS, port: Number.NaN });
    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });
});

describe('MinioFileStorage — M4 bucket ensure + NoSuchBucket', () => {
  it('creates the bucket on first use when it does not exist', async () => {
    const client = makeFakeClient({ bucketExists: jest.fn(async () => false) });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' });

    expect(client.bucketExists).toHaveBeenCalledWith('task-photos');
    expect(client.makeBucket).toHaveBeenCalledWith('task-photos');
    expect(client.putObject).toHaveBeenCalled();
  });

  it('does NOT create the bucket when it already exists', async () => {
    const client = makeFakeClient({ bucketExists: jest.fn(async () => true) });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' });

    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it('NoSuchBucket is NOT masked as not-found: get() rejects instead of returning null', async () => {
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => true), // skip ensure so statObject error surfaces
      statObject: jest.fn(async () => {
        throw Object.assign(new Error('bucket missing'), { code: 'NoSuchBucket' });
      }),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await expect(storage.get('k')).rejects.toMatchObject({ code: 'NoSuchBucket' });
  });

  it('a real missing object (NoSuchKey) still returns null', async () => {
    const client = makeFakeClient({
      statObject: jest.fn(async () => {
        throw Object.assign(new Error('no key'), { code: 'NoSuchKey' });
      }),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await expect(storage.get('k')).resolves.toBeNull();
  });
});

describe('MinioFileStorage — M1 timeout', () => {
  it('save() rejects within the timeout window when putObject never resolves', async () => {
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => true),
      putObject: jest.fn(() => new Promise<never>(() => { /* never resolves */ })),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, timeoutMs: 50, clientFactory: () => client });

    const started = Date.now();
    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ── [1] race condition en ensureReady → doble makeBucket ──────────────────────
describe('MinioFileStorage — [1] memoized bucket-ensure (no double makeBucket under concurrency)', () => {
  it('makeBucket runs exactly ONCE when N operations race on a fresh (missing) bucket', async () => {
    let makeBucketCalls = 0;
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => false), // bucket NO existe en el primer uso
      makeBucket: jest.fn(async () => {
        makeBucketCalls += 1;
      }),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    // 3 operaciones concurrentes en el PRIMER uso (la promesa de ensure debe memoizarse)
    await Promise.all([
      storage.save({ key: 'a', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
      storage.save({ key: 'b', buffer: Buffer.from('y'), mimeType: 'image/jpeg' }),
      storage.save({ key: 'c', buffer: Buffer.from('z'), mimeType: 'image/jpeg' }),
    ]);

    expect(makeBucketCalls).toBe(1);
    expect(client.bucketExists).toHaveBeenCalledTimes(1);
  });

  it('tolerates BucketAlreadyOwnedByYou from makeBucket (idempotent): save still succeeds', async () => {
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => false),
      makeBucket: jest.fn(async () => {
        throw Object.assign(new Error('owned'), { code: 'BucketAlreadyOwnedByYou' });
      }),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).resolves.toBeUndefined();
    expect(client.putObject).toHaveBeenCalled();
  });

  it('a failed ensure is NOT cached: the next operation retries bucketExists', async () => {
    let existsCalls = 0;
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => {
        existsCalls += 1;
        if (existsCalls === 1) throw Object.assign(new Error('flaky'), { code: 'EUNKNOWN' });
        return true;
      }),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, clientFactory: () => client });

    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toThrow('flaky');
    // segundo intento: la promesa fallida NO quedó memoizada → reintenta y ahora pasa
    await expect(
      storage.save({ key: 'k', buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).resolves.toBeUndefined();
    expect(client.bucketExists).toHaveBeenCalledTimes(2);
  });
});

// ── [2] timeout debe cubrir la LECTURA del stream, no solo getObject ───────────
describe('MinioFileStorage — [2] timeout covers stream READ (not just getObject)', () => {
  function neverEndingStream(): Readable {
    let pushed = false;
    return new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(Buffer.from('partial')); // emite el primer chunk…
        }
        // …y NUNCA push(null): el body se estanca y el stream jamás termina.
      },
    });
  }

  it('get() times out if the body stalls after the first chunk (stream never ends)', async () => {
    const stream = neverEndingStream();
    const client = makeFakeClient({
      bucketExists: jest.fn(async () => true),
      statObject: jest.fn(async () => ({ metaData: { 'content-type': 'image/jpeg' } })),
      getObject: jest.fn(async () => stream),
    });
    const storage = new MinioFileStorage({ ...GOOD_OPTS, timeoutMs: 50, clientFactory: () => client });

    try {
      const started = Date.now();
      await expect(storage.get('k')).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      stream.destroy();
    }
  });
});
