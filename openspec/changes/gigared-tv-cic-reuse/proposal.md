# Proposal — `gigared-tv-cic-reuse`

## Intent

Desbloquear el alta de TV, hoy **rota al 100%**, y hacer que el sistema pueda **reutilizar los CICs reciclados por las bajas** en vez de rechazarlos en bloque.

## Problema (confirmado en vivo, no inferido)

`POST /api/gigared/customers/{id}/register` devuelve **404 `GIGARED_NOT_FOUND`** para **todos** los clientes, siempre.

El pool `unregistered` del partner tiene 10 cuentas:

| Situación | Cantidad |
|---|---|
| Con `internal_id` de un cliente NUESTRO ya dado de baja localmente | **8** |
| Con `internal_id` de un cliente nuestro **sin** baja local (`ALVEZ SUSANA`) | 1 |
| Sin `internal_id` (limpio) pero con el **CIC corrupto** (`'00065470 4'`, byte `0x20`) | **1** |

Cadena del fallo, en `RegisterGigaredAccount.resolveGigaredAccount`:

1. El filtro anti-veneno B1 valida **presencia** de `cic`, no su **formato** → el CIC con espacio pasa como "limpio".
2. `clean.length === 1` → `Math.floor(Math.random() * 1)` es **0 siempre**. Un pick aleatorio sobre un pool de un elemento es determinístico.
3. `register({cic: '00065470 4'})` → el partner responde **403 `cic-ownership-error`**.
4. `mapError` lo traduce a `GigaredNotFoundError` (decisión #47d: *not owned ≡ not found*).
5. El `catch` del `register` sólo contempla `GigaredRejectedError` → **rethrow crudo** → 404 al operador.

**Un solo dato corrupto, en el único candidato válido, bloquea toda la operación.**

## Causa de fondo

B1 se escribió tras el incidente Centeno y rechaza **todo** CIC estampado, sin mirar de quién es. No distingue dos casos que no se parecen:

- **Peligroso** — el CIC carga la identidad de un tercero **vivo**, se asigna en silencio y nadie se entera. Es el incidente Centeno. **Debe seguir bloqueado.**
- **Seguro** — el CIC carga la identidad de un cliente **nuestro, ya severado localmente** (`tvCancelledAt`). Reutilizarlo es el comportamiento deseado.

El mecanismo de reutilización **ya está verificado en vivo** (probe Martino, 2026-07-10): `PATCH internal_id` es *append-only*, así que ambos ids resuelven al mismo CIC y el estampado del cliente nuevo funciona. El ownership vive **local** (`tvCancelledAt` + seq #81), nunca en el payload del partner.

## Qué NO se toca — decisión explícita del usuario (2026-07-30)

**Los tres comportamientos quedan exactamente como están.**

| Comportamiento | Implementación | Estado |
|---|---|---|
| Alta | `register` + `activate` + estampar identidad | se corrige (este change) |
| Pausar | `setOtt(false/true)` | **sin cambios** |
| Baja | quitar add-ons + pausar + **`renewCic`** + flag local | **sin cambios** |

Se **revierte** la propuesta de engram `gigared/baja-debe-ser-pausa-no-renew` (#2076). El `renewCic` no es el bug: es justamente lo que borra los datos personales y devuelve el slot al pool — probado por los `null` de `email` / `first_name` / `last_name` / `registration_date` y por `qty_registered_devices: 0` en las 10 cuentas.

Convertir la baja en pausa sería **peor**: la cuenta quedaría registrada a nombre del cliente que se fue, **no** volvería al pool, y la licencia se consumiría igual. El argumento *"el renew no libera la licencia"* no sostiene la propuesta, porque **pausar tampoco la libera**.

### Corrección del modelo de licencias

`qty_available: 0` del Play Full **no es un síntoma**. El pack base es **uno por slot de cuenta, permanente**: 150 comprados = 150 cuentas, cada una con su Play Full colgado (140 `registered` + 10 `unregistered` = 150 `used`). Ese contador dirá 0 siempre.

Los add-ons sí entran y salen — Todo Fútbol va 110/150 con **40 libres**, que es lo que la baja libera correctamente. **No hay fuga de licencias; hay un techo de 150 cuentas.**

## Alcance

**Backend únicamente. Todo del lado del alta.**

1. **Refinar B1** — aceptar un CIC estampado cuando su `internal_id` resuelve a un cliente nuestro elegible; rechazar todo lo demás.
2. **Guard de formato del CIC** — un CIC que no sea puramente numérico nunca es candidato.
3. **Preferencia limpio-primero** — reutilizar sólo cuando no hay ningún CIC limpio, para minimizar la acumulación de alias.
4. **Reintento acotado** — que un CIC inservible no tumbe el alta entera.
5. **Errores tipados** en las 5 llamadas al partner hoy sin proteger.
6. **Logging del 403/404** — hoy no dejan rastro y por eso esto fue invisible.
7. **Auditoría de la reutilización** — qué CIC se reusó y de quién era.

## Fuera de alcance

- `CancelTv`, `SetOttStatus`, `AddTvService`, `RemoveTvService`.
- Frontend (el contrato del DTO no cambia; sólo mejoran los códigos de error, que el FE ya mapea genéricamente).
- El caso `ALVEZ SUSANA BEATRIZ` — desincronización real, **card aparte**.
- El CIC corrupto `00065470 4` — acción no-código de Gigared. Con este change deja de bloquear.

## Riesgo aceptado

Los alias **se acumulan**: cada reutilización deja un puntero muerto más apuntando a una cuenta viva, tapado por el flag local y por el seq. Si alguno de los dos mecanismos falla para un cliente puntual, ese cliente vería la TV de otro — el modo de falla de Centeno.

Se mitiga con: preferencia limpio-primero, la invariante chequeada en código, y el rastro de auditoría obligatorio.

## Decisión de UX

**Automático, con rastro. Sin modal de confirmación.**

El operador no tiene información para decidir: no sabe qué CICs están estampados ni de quién. Un modal sería decoración y le transferiría una responsabilidad que no puede ejercer. Lo que protege es la invariante en código, el evento de auditoría, y que la reutilización sea **visible después** en el Historial de TV.
