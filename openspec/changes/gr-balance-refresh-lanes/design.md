# Design — `gr-balance-refresh-lanes`

## Decisión 1 — Un solo use case parametrizado, no dos clases

`RefreshDebtorBalances` recibe un **carril** explícito (`{ entity, estados }`) en vez de la
constante de módulo `DEBTOR_LIKE_STATUSES`. El composition root instancia dos veces la misma
clase.

- **Por qué no dos clases**: la lógica (enumerar → deduplicar → balance → `upsertInvoices` →
  `SyncState`) es idéntica; duplicarla crea el escenario "el fix se aplica a un hermano y no al
  otro" que ya nos mordió (`fix-wave-buscar-el-hermano`).
- **Sin default**: el carril es un parámetro REQUERIDO. Con dos carriles no hay default
  correcto, y el bug que estamos arreglando ES un default que nadie volvió a mirar. Sin
  default, olvidarse de configurarlo **no compila**.

## Decisión 2 — El carril rápido HEREDA la entity `gr-debtor-balances`

`GetFinanceSyncStatus.ts:7` lee `'gr-debtor-balances'` para la tarjeta del dashboard de
Finanzas. Si el carril rápido estrenara nombre, esa tarjeta quedaría mostrando la última
corrida vieja **para siempre, sin error** — un huérfano silencioso.

⇒ rápido = `gr-debtor-balances` (el nombre queda algo impreciso, pero la continuidad de la
observabilidad vale más que el nombre); lento = `gr-balances-bajas` (nuevo).

## Decisión 3 — "Diario" se decide por reloj AR + `SyncState`, no por `setInterval(24h)`

Un `setInterval` de 24 h ancla la corrida al momento del deploy: deployás a las 14:00 y el
carril lento corre todos los días a las 14:00, en pleno horario de trabajo.

⇒ el ticker sigue siendo horario y una **función pura** decide si corresponde correr:

```ts
shouldRunDailyLane(lastRunAt: Date | null, now: Date): boolean
```

`true` si la hora AR está en `[3,6)` y el día calendario AR de `lastRunAt` ≠ el de `now`.

- **TZ explícita con `Intl`** (`America/Argentina/Buenos_Aires`), mismo patrón que
  `arCalendarDate` en `mapGrInvoice.ts` y que el `isoDate()` del password diario de GR: el
  contenedor corre en **UTC** y `getHours()` mentiría 3 horas.
- **Ventana de 3 h, no de 1**: si el guard de exclusión (Decisión 4) le come el tick de las
  3:00 porque el rápido está en vuelo, todavía tiene las 4:00 y las 5:00 para entrar. Una
  ventana de una hora podría saltearse días enteros en silencio.
- **Pura ⇒ testeable** sin scheduler ni relojes falsos (LANE-2.2).

## Decisión 4 — Guard de exclusión COMPARTIDO entre los dos carriles

Hoy `startBalanceBatchJob` tiene un `inFlight` **por job**. Con dos jobs, cada uno tendría el
suyo y podrían correr en paralelo: 2 streams simultáneos contra GR justo cuando el rápido está
a mitad de sus 43 min. El propio código ya advierte del riesgo de 429s.

⇒ un único flag compartido por closure entre los dos jobs. El que llega segundo no corre y
reintenta en su próximo tick (por eso la ventana de 3 h del carril lento).

**Se acepta**: cuando el lento corre (~70 min), el rápido saltea 1-2 ticks. Una vez por día, de
madrugada. Es exactamente lo que ya pasa hoy todo el día, y acá es deliberado y acotado.

## Decisión 5 — El refresh del portal calca el patrón de `GetClientDetail`

`ListPortalInvoices` recibe `RefreshClientBalanceIfStale` como colaborador **opcional**
(igual que `GetClientDetail`), y necesita `grClienteId` + `lastBalanceAt` ⇒ un
`customers.findById(clientId)` previo, que `GetPortalMe` ya hace en su propia ruta.

- **Opcional, no requerido**: mantiene el use case construible sin él en los tests que no lo
  ejercitan, igual que el hermano del panel. El wiring real se fija con el composition-root
  test (lección W6 del EPIC #38: sin eso la feature nace muerta con el CI en verde).
- **`clientId` SIEMPRE del token** — la ruta ya lo resuelve con `requireClientId(req,res)`; el
  refresh no agrega ninguna superficie nueva de IDOR (PORTAL-1.3).
- **Costo**: un `findById` extra por request de facturas, y hasta 4 s de latencia en la primera
  lectura de cada ventana de TTL. Aceptado — es el mismo trade-off ya aceptado en el panel, y
  la alternativa es mostrarle al cliente una factura que ya pagó.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El carril rápido (43 min medidos) crece con la base de clientes y vuelve a pasarse de la hora | El cálculo queda escrito en el proposal con la latencia medida; si la base crece ~40% hay que revisar. No se agrega alarma en este change (fuera de alcance, se anota como deuda). |
| GR devuelve 429 con más presión sobre el endpoint `cliente` | El volumen TOTAL de llamadas **no aumenta** (se redistribuye). El guard de exclusión evita duplicar la carga instantánea. |
| Los tests viejos pineaban la exclusión de activos | Se actualizan explícitamente, con el porqué escrito en el spec (LANE-1.1) y evidencia en vivo en el proposal — no es maquillar un test para que pase. |

## Sin migración de base de datos.
