# Tech Location Ingest Specification (Wave 2b)

## Purpose

Ingest de breadcrumbs GPS desde la app propia del técnico, escribiendo en la MISMA tabla `TeamLocationPoint` (`schema.prisma:4277`) que hoy alimenta solo IClass — depende de la migración aditiva de `iclass-team-location-ingest` (wave 2a: `source` default `'iclass'` + `technicianId` nullable FK). v1 exige conectividad; la app puede acumular offline y mandar el lote junto (batch), pero no hay cola de sincronización robusta (fuera de scope).

## Requirements

### Requirement: Breadcrumbs are anchored to the technician of the token

El sistema DEBE (MUST) resolver la identidad de CADA punto ingresado por `POST /api/tech/location` desde `req.technicianId` (nunca del body) — mismo anti-IDOR que el resto de `/api/tech/*`.

El sistema DEBE (MUST) resolver `teamLogin` así (`design.md` Decision 5): `teamLogin = RbacUser.iclassTeamLogin ?? 'tech:' + RbacUser.id` (soft-FK `iclassTeamLogin` ya existente, `schema.prisma:3304`), y persistir `technicianId = req.technicianId`, `source = 'app'`. `teamLogin` sigue siendo `NOT NULL` en `TeamLocationPoint` — el fallback sintético `tech:{rbacUserId}` existe para que un técnico SIN mapeo a cuadrilla IClass no pierda su rastro (perder el dato es peor que un login sintético). El unique natural `(teamLogin, recordedAt, latitude, longitude)` sigue dando idempotencia gratis también para el login sintético.

#### Scenario: Points are attributed to the authenticated technician
- GIVEN el técnico `tech-A` con `iclassTeamLogin='IPNXANDYM'`
- WHEN `tech-A` hace `POST /api/tech/location` con un lote de puntos
- THEN cada punto persiste con `technicianId='tech-A'`, `teamLogin='IPNXANDYM'`, `source='app'`

#### Scenario: Technician without an IClass team mapping gets a synthetic teamLogin, never rejected
- GIVEN el técnico `tech-C` con `iclassTeamLogin=null`
- WHEN `tech-C` hace `POST /api/tech/location`
- THEN cada punto persiste con `technicianId='tech-C'`, `teamLogin='tech:tech-C'`, `source='app'` — el batch se acepta igual que para un técnico mapeado, NUNCA un 422/500 por falta de mapeo

### Requirement: The batch endpoint accepts accumulated offline points, capped at 200

El sistema DEBE (MUST) aceptar un lote de hasta **200 puntos** en un solo `POST` (la app puede juntar puntos capturados sin conexión y mandarlos juntos al recuperar señal). Un batch de MÁS de 200 puntos se rechaza ENTERO — `400 { code: 'BATCH_TOO_LARGE' }` — sin persistir nada; no hay procesamiento parcial de un batch sobre el cupo.

#### Scenario: A batch of points from an offline gap is accepted
- GIVEN la app acumuló 40 puntos sin conexión entre las 10:00 y las 10:35
- WHEN recupera señal y hace `POST /api/tech/location` con los 40 puntos
- THEN los 40 se procesan en la misma request

#### Scenario: A batch over the cap is rejected whole, with a clear code
- GIVEN la app juntó 210 puntos sin conexión
- WHEN hace `POST /api/tech/location` con los 210 puntos en un solo batch
- THEN `400 { code: 'BATCH_TOO_LARGE' }`, NINGÚN punto del batch se persiste

### Requirement: An individually invalid point is dropped, never the whole batch

El sistema DEBE (MUST) validar cada punto de forma INDEPENDIENTE y descartarlo (`dropped`) sin rechazar el resto del batch cuando: `latitude`/`longitude` están fuera de rango geográfico válido, o `recordedAt` es futuro (más de 5 minutos de skew) o anterior a 7 días. Un punto malo NO puede tirar el rastro de la jornada entera.

La ÚNICA causa de `400 VALIDATION_ERROR` del batch completo es `points` ausente o vacío — nunca un punto individualmente inválido dentro de un array no vacío.

#### Scenario: One bad point is dropped, the rest of the batch is accepted
- GIVEN un batch de 10 puntos donde el punto 5 tiene `latitude=200` (fuera de rango)
- WHEN se procesa `POST /api/tech/location`
- THEN 9 puntos se persisten, 1 aparece en `dropped`, la respuesta es `201`, no `400`

#### Scenario: A point timestamped too far in the future is dropped
- GIVEN un punto con `recordedAt` 20 minutos en el futuro respecto del reloj del servidor
- WHEN se procesa el batch
- THEN ese punto se dropea (excede el skew de 5 minutos), el resto del batch se procesa normalmente

#### Scenario: Empty points array is a full 400, not a drop-everything 201
- GIVEN `POST /api/tech/location` con `{ points: [] }`
- WHEN se procesa
- THEN `400 { code: 'VALIDATION_ERROR' }`

### Requirement: Retries of the same batch do not duplicate points

El sistema DEBE (MUST) ser idempotente ante reintentos: reenviar el MISMO lote (p. ej. la app no recibió la confirmación de red) no debe duplicar filas. Reusa la unicidad natural ya existente: `(teamLogin, recordedAt, latitude, longitude)` (`schema.prisma:4309`).

#### Scenario: A retried batch is a no-op on the duplicates
- GIVEN un lote de 40 puntos ya fue aceptado y persistido
- WHEN la app reintenta el MISMO lote (timeout de red, sin haber visto la respuesta)
- THEN el conteo de filas para esos 40 puntos no cambia
- AND la respuesta reporta cuántos eran nuevos (0) y cuántos duplicados (40)

**Limitación conocida y ACEPTADA (no un TODO):** la unicidad `(teamLogin, recordedAt, latitude, longitude)` no incluye `source` (`iclass-team-location-ingest`, wave 2a). Si un punto `source='app'` coincide EXACTAMENTE en los 4 campos con uno `source='iclass'` ya persistido — mismo `teamLogin`/`recordedAt` al milisegundo y mismas coordenadas redondeadas, desde dos fuentes independientes — la escritura de la app colisiona con la constraint y se contabiliza como duplicado aunque venga de otro origen. Es un edge inalcanzable en la práctica (exige coincidencia exacta cruzada entre dos fuentes independientes); no se propone tocar la constraint existente en esta wave.

### Requirement: Live map and audit read app-origin points without query changes

(Cubierto en detalle por la delta de `iclass-team-live-map`.) Los puntos `source='app'` DEBEN (MUST) aparecer en `/live`, `/journey` y `/audit/*` junto a los de `source='iclass'`, sin que el consumidor de esas rutas necesite saber de dónde vino cada punto.

#### Scenario: An app-origin point counts toward the daily journey
- GIVEN el técnico `tech-A` (mapeado a `IPNXANDYM`) mandó 12 puntos hoy desde la app
- AND IClass trajo otros 8 puntos de la misma cuadrilla el mismo día
- WHEN se consulta `GET /api/technicians/IPNXANDYM/journey`
- THEN la jornada reporta 20 puntos, sin distinguir origen en el conteo

## HTTP Contract

### POST /api/tech/location
Headers: `Authorization: Bearer <accessToken>` (`aud='tech'`)
Body:
```ts
{
  points: Array<{
    latitude: number;
    longitude: number;
    recordedAt: string;   // ISO 8601, instante del fix
    accuracyM?: number | null; // metros, mismo campo que TeamLocationPoint.accuracyM
  }>;
}
```
Response `201`:
```ts
{ accepted: number; duplicates: number; dropped: number }
```
Cap: máx 200 puntos por request. `sources: []` (array vacío) para todo punto persistido con `source='app'` — la columna `TeamLocationPoint.sources` (`Int[]`, NOT NULL) modela los códigos `origem` que emite IClass; no tiene equivalente en el dominio de la app, así que queda vacía por diseño (`design.md` Decision 5). El discriminador de origen es `source` (string), NUNCA `sources` (array de códigos IClass) — nombres parecidos, no confundir.

Errors:
| Status | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `points` ausente o vacío |
| 400 | `BATCH_TOO_LARGE` | más de 200 puntos en el batch |

**Resuelto en sdd-design** (ya no es incógnita): cap de batch (200), semántica de drop-por-punto vs. rechazo del batch entero, y valor de `sources: []` para puntos `source='app'` — ver `design.md` Decision 5. La precondición dura `TECHNICIAN_TEAM_NOT_MAPPED` propuesta en una versión anterior de este spec fue DESCARTADA: el ingest nunca rechaza por falta de mapeo, resuelve `teamLogin` sintético (`tech:{rbacUserId}`) — ver el requirement de arriba.

## Aditivo, solo-crece
Endpoint nuevo, tabla existente extendida de forma aditiva (wave 2a). El shape del body es solo-crece: nuevos campos opcionales por punto se agregan, nunca se renombran.
