# ADR 0005 — Scheduler in-process detrás de un flag

## Status

Aceptado · vigente.

## Context

El mirror de Gestión Real necesita correr periódicamente (polling). Las opciones
eran: un cron externo, un job runner dedicado (BullMQ/Redis), o un scheduler
**in-process** dentro del mismo proceso de Node. El ISP corre el backend como un
único contenedor; introducir Redis o un worker separado sería infraestructura
extra para un solo job de polling.

Además, el sync debía poder **apagarse por completo** sin afectar al resto del
sistema (en dev, en CI, o si GR no está configurado).

## Decision

Usar un **scheduler in-process** (`GestionRealSyncScheduler`,
`src/infrastructure/scheduling/GestionRealSyncScheduler.ts`), arrancado desde
`main.ts`, **detrás del flag `GR_SYNC_ENABLED`**.

Propiedades de diseño:

1. **Opt-in total.** `config.gestionReal.enabled = GR_SYNC_ENABLED === 'true'`.
   El bootstrap (`bootstrapGestionRealSync`) devuelve `null` si está apagado o si
   faltan `GR_CUIT`/`GR_SECRET`. `main.ts` hace `grSync?.start()`: con `null`, es
   un no-op. **Apagar = el server se comporta exactamente como antes.** Ninguna env
   var de GR es requerida por `config.ts`.
2. **Intervalo configurable.** `GR_SYNC_INTERVAL_MS` (default 180000 = 3 min). Usa
   `||` (no `??`) para que un string vacío de un secret de CI sin setear caiga al
   default.
3. **Lock in-flight.** Un único flag `inFlight` evita runs solapados si un sync
   dura más que el intervalo.
4. **Errores tragados por ciclo.** Un ciclo que falla loguea y retorna; nunca mata
   el timer ni el proceso. Combinado con los handlers de `unhandledRejection` /
   `uncaughtException` en `main.ts`, el server sigue sirviendo aunque GR caiga.
5. **`timer.unref()`** para no mantener vivo el event loop solo por el timer.
6. **Estados a sincronizar configurables.** `GR_SYNC_ESTADOS` (default `1,2` =
   Activo, Deudor).

## Consequences

**Positivas**
- Cero infraestructura extra (sin Redis, sin worker). Un solo contenedor.
- Aislamiento total: el flag apagado deja el sistema idéntico al estado pre-mirror.
- Resiliente: un GR caído degrada solo el mirror, no el server.

**Negativas / límites conocidos**
- **No escala horizontalmente.** Si se corren N réplicas del backend, cada una
  arranca su propio scheduler → N syncs concurrentes contra GR. Hoy es un solo
  contenedor; si se escala, hay que mover el sync a un worker dedicado o agregar
  un lock distribuido. **Esta es la deuda técnica principal del feature.**
- El estado de progreso vive en la tabla `SyncState` (compartida), pero el lock
  `inFlight` es **en memoria por proceso**, no distribuido.
