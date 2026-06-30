# Design: Delta PROPIO de contratos de Gestión Real

## Context

El sync de contratos GR es **esclavo** del delta de clientes. El scheduler hace:

```ts
// GestionRealSyncScheduler.runOnce() — líneas 84-89
const clients = await this.syncClients.execute();
const contractIds = clients.mode === 'backfill' ? clients.createdClientIds : clients.touchedClientIds;
const contracts = await this.syncContracts.execute(contractIds);   // fetchContractsByClient(cli) por cada uno
```

`SyncGestionRealContracts.execute(grClienteIds)` solo refresca contratos de **clientes que el client-sync tocó este tick**. Un contrato modificado/creado/reasignado de forma **asíncrona** respecto a la `ultima_modificacion` del cliente NO entra → no se espeja. Es la causa raíz del bug de titularidad.

El comentario del propio use case lo admite: *"GR has no contract delta feed"*. **Ese supuesto era falso** — verificado en vivo: GR expone `action: "contratos"` + `fecha_tipo: "m"` SIN `cliente_id` (delta global por fecha de modificación, paginado). Eso habilita un delta de contratos PROPIO.

## Alternativas evaluadas

| Alternativa | Cómo | Veredicto |
|-------------|------|-----------|
| **A. Delta de contratos propio (global feed)** | Nuevo use case que pagina `action:contratos&fecha_tipo=m` con cursor propio, igual que el delta de clientes | **ELEGIDA.** GR soporta el feed global (probado: 324 contratos/12 días). Determinístico, acotado (paginado), idempotente, simétrico al patrón ya probado de clientes. Cierra el gap async de raíz. |
| B. Trigger desde `gr-ingest` | Cuando `gr-ingest` detecta `contract-unmirrored`, disparar un fetch puntual del contrato | Reactivo y parcial: solo cubre contratos que tienen una OS pendiente ingerida. Un contrato sin OS nunca se dispara. Acopla el sync al pipeline de órdenes. Descartada. |
| C. Re-fetch periódico de TODOS los contratos | Escanear el universo entero cada N | Es lo que ya hace `gr-contracts-backfill` (resumable). Caro para correr seguido; no es un "delta". El backfill cubre el histórico; para el día a día querés delta. Descartada como mecanismo principal. |

**A gana** porque GR soporta el feed global: es el mismo patrón que ya funciona para clientes, con cursor propio, sin reinventar nada.

## Decisión 1 — Nuevo método en el port (paginado)

Extender `GestionRealPort` con un método para el delta global. Tipos análogos a `FetchClientsParams`/`FetchClientsResult`:

```ts
// domain/ports/GestionRealPort.ts
export interface FetchContractsDeltaParams {
  /** Lower bound "DD-MM-AAAA" (modificación). */
  fechaDesde: string;
  /** Upper bound "DD-MM-AAAA". */
  fechaHasta: string;
  /** Page size — GR caps at 100. */
  cantidad: number;
  offset: number;
}

export interface FetchContractsDeltaResult {
  /** Total rows matching (GR "resultados"), drives paging. */
  total: number;
  contracts: GrContract[];
}

export interface GestionRealPort {
  // ...existentes...
  /**
   * Global contract delta by modification date (action:contratos, fecha_tipo=m).
   * Each item carries its OWN cliente_id — the parser stamps grClienteId PER ITEM.
   */
  fetchContractsModifiedSince(params: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult>;
}
```

> Nombre `fetchContractsModifiedSince` (no `fetchContractsDelta`) para que el nombre comunique el eje (`fecha_tipo=m`). Es aditivo: no toca `fetchContractsByClient`.

## Decisión 2 — Parser nuevo POR ITEM (no reusar el existente)

`parseContractsResponse(data, grClienteId)` (GestionRealClient línea 213) estampa `grClienteId` del **PARÁMETRO** — sirve para `fetchContractsByClient` (un cliente). El delta global trae contratos de **muchos** clientes → necesita un parser que tome `cliente_id` de **cada item** y lea `resultados` para paginar:

```ts
// GestionRealClient.ts — método
async fetchContractsModifiedSince(p: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult> {
  const { data } = await this.http.post('', {
    action: 'contratos', fecha_tipo: 'm',
    fecha_desde: p.fechaDesde, fecha_hasta: p.fechaHasta,
    cantidad: p.cantidad, offset: p.offset,
  }, { auth: this.auth() });
  return parseContractsDeltaResponse(data);
}

// parser nuevo (exportado, testeable puro)
export function parseContractsDeltaResponse(data: unknown): FetchContractsDeltaResult {
  const root = (data ?? {}) as Record<string, unknown>;
  const total = parseInt(String(root.resultados ?? '0'), 10) || 0;
  const list = Array.isArray(root.contratos) ? (root.contratos as Record<string, unknown>[]) : [];
  const contracts: GrContract[] = list.map(c => ({
    grContratoId: str(c.id) ?? '',
    grClienteId: str(c.cliente_id) ?? '',   // ← POR ITEM (clave del fix)
    plan: str(c.nombre),
    status: str(c.estado),
    startDate: str(c.inicio),
    address: str(c.domicilio) || null,
    lat: numOrNull(c.lat),
    lng: numOrNull(c.lng),
    pppoeUsername: null,                     // el feed global no trae conexiones; el por-cliente lo cubre
    modificado: str(c.modificado),
    vendedor: str(c.vendedor),
    raw: c,
  }));
  return { total, contracts };
}
```

Reusa los helpers puros existentes (`str`, `numOrNull`). `pppoeUsername` queda `null` (el feed no trae `conexiones`); no importa porque `upsertContract` NO persiste `pppoeUsername`.

## Decisión 3 — Use case `SyncGestionRealContractsDelta` (cursor propio, bootstrap a hoy)

Espejo de `SyncGestionRealClients`, pero **sin modo backfill histórico** (el histórico es de `gr-contracts-backfill`). El cursor SIEMPRE corre como delta; en la primera corrida (sin cursor) bootstrapea a **hoy**:

```ts
const SYNC_ENTITY = 'gr-contracts-delta';      // ← entity PROPIO, NO 'gr-contracts-backfill'
const SYNC_FLAG_KEY = 'gestion-real-sync';     // ← reusa el master switch

class SyncGestionRealContractsDelta {
  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    private readonly state: SyncStateRepository,
    private readonly featureFlags: FeatureFlagRepository,
    opts: { now?: () => Date; pageSize?: number } = {},
  ) { /* now, pageSize=100 */ }

  async execute(): Promise<ContractDeltaResult> {
    const flag = await this.featureFlags.get(SYNC_FLAG_KEY);
    if (!flag?.enabled) return { fetched: 0, created: 0, updated: 0, skipped: 0, cursor: '', skippedFlag: true };

    const prior = await this.state.get(SYNC_ENTITY);
    const runDate = formatGrDate(this.now());
    // Bootstrap: sin cursor → desde = hoy (NO histórico). Con cursor → re-scan día-granular desde el último run.
    const fechaDesde = prior?.cursor ?? runDate;

    let fetched = 0, created = 0, updated = 0, skipped = 0;
    try {
      let offset = 0;
      while (true) {
        const { total, contracts } = await this.gr.fetchContractsModifiedSince(
          { fechaDesde, fechaHasta: runDate, cantidad: this.pageSize, offset });
        for (const contract of contracts) {
          const r = await this.mirror.upsertContract(contract);  // guard !parent → created:false (skip)
          if (r.created) created++; else updated++;
          fetched++;
        }
        offset += this.pageSize;
        if (contracts.length === 0 || offset >= total) break;
      }
    } catch (err) {
      await this.state.save({ entity: SYNC_ENTITY, cursor: prior?.cursor ?? null, lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`, itemsSynced: fetched });
      throw err;
    }
    await this.state.save({ entity: SYNC_ENTITY, cursor: runDate, lastRunAt: this.now(),
      lastResult: 'ok', itemsSynced: fetched });
    return { fetched, created, updated, skipped, cursor: runDate };
  }
}
```

Decisiones internas:
- **Bootstrap a hoy** (D2 del proposal): la primera corrida escanea solo el día de hoy y persiste cursor = hoy. El universo histórico ya lo cubrió `gr-contracts-backfill` → **NO** re-escaneamos años de contratos acá. Si el operador quisiera re-traer histórico de contratos, usa el backfill, no este delta.
- **Re-scan día-granular**: `fechaDesde = prior.cursor` (la fecha del run anterior) → overlap de ≥1 día. Como `upsertContract` es idempotente, el solapamiento garantiza no perder cambios del mismo día (igual que clientes).
- **Cursor propio `gr-contracts-delta`**: distinto del offset numérico de `gr-contracts-backfill`. Cero colisión.
- **Guard `!parent`**: si el cliente dueño aún no se espejó, `upsertContract` devuelve `created:false` y saltea. Como el **client-sync corre ANTES en el mismo tick**, el caso típico (cliente nuevo + contrato nuevo) ya tiene el cliente espejado cuando corre el delta. El residual se recupera en el overlap del siguiente tick (mientras la mod del contrato siga dentro de `[cursor, hoy]`). Best-effort, documentado.

## Decisión 4 — Orden en el scheduler (delta tras el client-sync)

```ts
// GestionRealSyncScheduler.runOnce()
const clients = await this.syncClients.execute();
const contractIds = clients.mode === 'backfill' ? clients.createdClientIds : clients.touchedClientIds;
const contracts = await this.syncContracts.execute(contractIds);    // por-cliente (SE MANTIENE, D1)
const contractsDelta = await this.syncContractsDelta.execute();      // ← NUEVO, delta global
let backfill; if (this.backfill) backfill = await this.backfill.execute();
```

- El delta corre **después** del client-sync → clientes nuevos ya existen → `!parent` casi nunca dispara.
- **Mantener el por-cliente** (D1): cubre contratos modificados en sync con su cliente este tick (refresh inmediato). El delta global cubre el gap async. Idempotentes entre sí.
- `syncContractsDelta` se inyecta como dependencia **opcional** del scheduler (igual que `backfill`) para no romper tests que no lo ejercitan, o como requerida — decisión de implementación; recomiendo **opcional** para minimizar el blast radius en los tests existentes del scheduler.
- Errores swallowed en el `catch` del `runOnce` (ya está). El delta NO debe tumbar el tick.

## Decisión 5 — In-memory port

`InMemoryGestionRealPort` gana el doble del nuevo método: filtra una lista plana por `modificado >= fechaDesde`, pagina, registra calls:

```ts
contractsModified: GrContract[] = [];                 // fixture plano (multi-cliente)
contractsDeltaCalls: FetchContractsDeltaParams[] = [];

async fetchContractsModifiedSince(p: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult> {
  this.contractsDeltaCalls.push(p);
  const from = parseGrDate(p.fechaDesde);
  const matched = this.contractsModified.filter(c => {
    const mod = c.modificado ? parseGrDateTime(c.modificado) : null;
    return mod !== null && mod >= from;
  });
  const page = matched.slice(p.offset, p.offset + p.cantidad);
  return { total: matched.length, contracts: page };
}
```

Reusa `parseGrDate`/`parseGrDateTime` ya presentes en el doble. Mantiene la semántica real (filtra por `modificado`, pagina).

## Decisión 6 — Fix del bug secundario (`clientId` en el update)

En `PrismaClientMirrorRepository.upsertContract`, agregar `clientId: parent.id` al objeto `data` compartido (línea ~105-118), para que **ambos** branches (create y update) seteen el dueño. El `clientId: parent.id` explícito del `create` (línea 126) queda redundante → se puede dejar o quitar (mismo valor). Recomiendo moverlo al `data` y dejar el `create` con solo `grContratoId` extra:

```ts
const data = {
  type: 'internet',
  plan: k.plan ?? 'Sin plan',
  status: mapContractStatus(k.status),
  startDate: parseGrDate(k.startDate) ?? new Date(),
  address: k.address ?? null,
  lat: k.lat ?? null,
  lng: k.lng ?? null,
  vendedor: k.vendedor ?? null,
  clientId: parent.id,            // ← NUEVO: ahora el update también reasigna el dueño
};
// update: prisma.contract.update({ where: { grContratoId }, data });           ← ya reasigna clientId
// create: prisma.contract.create({ data: { ...data, grContratoId } });          ← clientId ya viene en data
```

> GR cambia el `grContratoId` al cambiar titularidad (no reasigna in-place), así que en la práctica esto es robustez defensiva, no el fix principal. Pero es barato y elimina una inconsistencia latente. Tiene test dedicado (in-memory).

## Test Strategy (TDD estricto, Jest + in-memory)

Use cases con `InMemory*` (NUNCA mockeando Prisma). El fix del `clientId` se testea contra el `InMemoryClientMirrorRepository` (verificar que su `upsertContract` ya reasigna por `grClienteId`, o alinearlo si no — debe espejar el contrato real). Parser puro testeable con un payload JSON de muestra.

Casos clave: delta detecta contrato modificado sin cambio de cliente · contrato reasignado a cliente nuevo · contrato con cliente inexistente se saltea y se recupera · paginación (total/offset) · cursor avanza · bootstrap a hoy en primera corrida · idempotencia same-day · flag OFF = no-op · parser toma `cliente_id` por item · `upsertContract.update` reasigna `clientId` · scheduler corre el delta tras el client-sync · composition root cablea el use case.

## DIP / arquitectura

- `SyncGestionRealContractsDelta` vive en `application/use-cases`, depende SOLO de ports (`GestionRealPort`, `ClientMirrorRepository`, `SyncStateRepository`, `FeatureFlagRepository`). CERO import de Prisma/axios/infra.
- El parser y el método HTTP viven en el adapter (`infrastructure/adapters/gestion-real`).
- El wiring concreto vive en el composition root (`bootstrapGestionRealSync`).
- Sin migración: `SyncState` se reusa con `entity = 'gr-contracts-delta'`.
