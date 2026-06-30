import { Client } from 'minio';
import { FileStorage, StoredFile } from '@domain/ports/FileStorage';
import { StorageNotConfiguredError } from '@domain/errors/taskAttachment';

/** Subconjunto del cliente MinIO que usamos. Permite inyectar un fake en tests. */
export interface MinioClientLike {
  putObject(
    bucket: string,
    key: string,
    buffer: Buffer,
    size: number,
    metaData?: Record<string, string>,
  ): Promise<unknown>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
  statObject(bucket: string, key: string): Promise<{ metaData?: Record<string, string> }>;
  removeObject(bucket: string, key: string): Promise<void>;
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<void>;
}

export interface MinioFileStorageOptions {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  /** Timeout por operación contra MinIO (ms). Default 15s. Un MinIO mudo no debe colgar el request. */
  timeoutMs?: number;
  /** Factory del cliente (inyectable en tests). Default: `new Client(...)` real. */
  clientFactory?: (opts: MinioFileStorageOptions) => MinioClientLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Códigos con los que MinIO/S3 reporta "el objeto no existe".
 * `NoSuchBucket` NO se incluye a propósito (M4): un bucket faltante es un fallo de
 * configuración/infra, no un 404 — no debe enmascararse como "objeto no encontrado".
 */
function isNotFoundError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'NoSuchKey' || code === 'NotFound';
}

/**
 * Códigos idempotentes de `makeBucket`: otra instancia/proceso (o un request concurrente)
 * ya creó el bucket. Tolerarlos hace la creación segura ante carreras — defensa extra a la
 * memoización de la promesa de `ensureReady`.
 */
function isBucketAlreadyOwnedError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists';
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Storage de producción sobre MinIO (S3-compatible). El BE es el único que habla con
 * MinIO (patrón BE-proxy): el bucket queda privado y se sirve vía el BE.
 *
 * LAZY (C1): el constructor SOLO guarda las opts y NUNCA tira. El cliente MinIO se
 * construye en el PRIMER uso (`getClient`), validando antes que la config exista; si
 * falta (MINIO_* vacías) → `StorageNotConfiguredError` (503). Así el BE BOOTEA aunque
 * MinIO no esté configurado: la feature de fotos degrada en vez de tumbar el server.
 */
export class MinioFileStorage implements FileStorage {
  private readonly opts: MinioFileStorageOptions;
  private readonly bucket: string;
  private client: MinioClientLike | null = null;
  /** Promesa in-flight del ensure del bucket (memoizada para evitar la carrera del doble makeBucket). */
  private ensurePromise: Promise<void> | undefined;

  constructor(opts: MinioFileStorageOptions) {
    // NO construir el Client acá: minio v8 valida endPoint en construcción y tiraría
    // InvalidEndpointError con config vacía, matando el boot.
    this.opts = opts;
    this.bucket = opts.bucket;
  }

  /** Construye (memoizado) el cliente al primer uso, validando la config primero. */
  private getClient(): MinioClientLike {
    if (this.client) return this.client;

    const { endPoint, port } = this.opts;
    if (!endPoint || endPoint.trim() === '') {
      throw new StorageNotConfiguredError('File storage (MinIO) endpoint is not configured');
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new StorageNotConfiguredError(`File storage (MinIO) port is invalid: ${port}`);
    }

    const factory =
      this.opts.clientFactory ??
      ((o: MinioFileStorageOptions): MinioClientLike =>
        new Client({
          endPoint: o.endPoint,
          port: o.port,
          useSSL: o.useSSL,
          accessKey: o.accessKey,
          secretKey: o.secretKey,
        }) as unknown as MinioClientLike);

    this.client = factory(this.opts);
    return this.client;
  }

  /**
   * getClient() + asegura el bucket una sola vez (M4).
   *
   * [1] Memoiza la PROMESA del ensure (no un booleano): dos requests concurrentes en el
   * PRIMER uso (bucket inexistente) comparten la MISMA promesa → `bucketExists`/`makeBucket`
   * corren UNA vez, sin la carrera check-then-act que disparaba un 2º `makeBucket` con
   * `BucketAlreadyOwnedByYou` (500 espurio). Si la promesa rechaza, se resetea a `undefined`
   * para permitir reintento en la próxima operación (un fallo transitorio no queda cacheado).
   */
  private async ensureReady(): Promise<MinioClientLike> {
    const client = this.getClient();
    this.ensurePromise ??= (async (): Promise<void> => {
      const exists = await this.withTimeout(client.bucketExists(this.bucket), 'bucketExists');
      if (!exists) {
        try {
          await this.withTimeout(client.makeBucket(this.bucket), 'makeBucket');
        } catch (e) {
          // Idempotente: si otro request/instancia ya lo creó, no es un error real.
          if (!isBucketAlreadyOwnedError(e)) throw e;
        }
      }
    })();
    try {
      await this.ensurePromise;
    } catch (e) {
      this.ensurePromise = undefined; // no cachear un ensure fallido → permite reintentar
      throw e;
    }
    return client;
  }

  /** Promise.race contra un timeout que rechaza; limpia el timer al terminar (M1). */
  private withTimeout<T>(p: Promise<T>, op: string): Promise<T> {
    const ms = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MinIO operation "${op}" timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  async save(input: { key: string; buffer: Buffer; mimeType: string }): Promise<void> {
    const client = await this.ensureReady();
    await this.withTimeout(
      client.putObject(this.bucket, input.key, input.buffer, input.buffer.length, {
        'Content-Type': input.mimeType,
      }),
      'putObject',
    );
  }

  async get(key: string): Promise<StoredFile | null> {
    const client = await this.ensureReady();
    // statObject resuelve existencia + content-type en un solo round-trip; si no existe
    // (NoSuchKey/NotFound) devolvemos null en vez de propagar el error.
    let mimeType = 'application/octet-stream';
    try {
      const stat = await this.withTimeout(client.statObject(this.bucket, key), 'statObject');
      const ct = stat.metaData?.['content-type'];
      if (typeof ct === 'string' && ct.length > 0) mimeType = ct;
    } catch (e) {
      if (isNotFoundError(e)) return null;
      throw e;
    }

    try {
      // [2] El timeout cubre TODA la operación get: obtener el stream Y drenar el body.
      //     Si MinIO entrega el stream pero estanca el body a mitad, igual hay deadline
      //     (antes el withTimeout solo envolvía getObject y la lectura quedaba sin tope).
      const buffer = await this.withTimeout(
        (async (): Promise<Buffer> => {
          const stream = await client.getObject(this.bucket, key);
          return streamToBuffer(stream);
        })(),
        'get',
      );
      return { buffer, mimeType };
    } catch (e) {
      if (isNotFoundError(e)) return null; // carrera: borrado entre stat y get
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.ensureReady();
    // removeObject de S3/MinIO es idempotente: borrar una key inexistente no es error.
    await this.withTimeout(client.removeObject(this.bucket, key), 'removeObject');
  }
}
