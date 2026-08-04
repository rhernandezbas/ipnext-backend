# Spec (delta) — `gr-balance-sync`

## LANE-1 — El refresh de balances corre en dos carriles

### LANE-1.1 — El carril rápido incluye a los clientes ACTIVOS
El carril rápido DEBE enumerar los estados GR `1` (Activo), `2` (Deudor), `3` (Inactivo) y
`4` (Incobrable).

- **Escenario**: hay un cliente `Activo` con facturas y un `Deudor` con facturas.
- **Entonces**: se piden los balances de LOS DOS.
- **Contra-escenario (revert-probe)**: si se saca el `'1'` de la lista del carril rápido, el
  test del activo DEBE ponerse en rojo.

> Este requisito REVIERTE explícitamente el comportamiento anterior, que excluía el estado 1
> apoyado en la premisa —refutada en vivo— de que los activos "siempre devuelven cero
> facturas". Los tests que pineaban esa exclusión (`not.toContain('A1')`) se actualizan: no se
> está maquillando el spec para que pase, se está corrigiendo un pin que la realidad refutó.

### LANE-1.2 — El carril lento cubre las Bajas
El carril lento DEBE enumerar el estado GR `6` (Baja) y NINGÚN otro.

- **Escenario**: hay un `Baja` y un `Activo`.
- **Entonces**: el carril lento pide el balance del `Baja` y NO el del `Activo`.

### LANE-1.3 — Los carriles no se pisan la observabilidad
Cada carril DEBE escribir su propio registro en `SyncState`, con una `entity` distinta.

- **Escenario**: corren los dos carriles.
- **Entonces**: existen dos filas de `SyncState` y ninguna sobreescribe a la otra.
- **Restricción dura**: el carril rápido conserva la entity **`gr-debtor-balances`**, porque
  `GetFinanceSyncStatus` la lee para el dashboard de Finanzas. Renombrarla dejaría esa tarjeta
  huérfana en silencio. El carril lento estrena `gr-balances-bajas`.

### LANE-1.4 — El carril es explícito, no tiene default
El use case NO DEBE exponer un default de estados: el carril se pasa siempre explícito desde
el composition root.

- **Por qué**: con dos carriles no existe un default correcto, y un default silencioso es
  exactamente la clase de bug que este change está arreglando (una lista de estados que nadie
  volvió a mirar). Sin default, una configuración incompleta **no compila**.

## LANE-2 — El carril lento corre una vez por día, de madrugada

### LANE-2.1 — Ventana horaria en hora ARGENTINA
El carril lento DEBE correr solo si la hora **de Argentina** está dentro de la ventana
`[3, 6)` y no corrió todavía ese día calendario argentino.

- **Escenario**: son las 03:30 ART y no corrió hoy → corre.
- **Escenario**: son las 14:00 ART → no corre.
- **Escenario**: son las 03:30 ART y ya corrió a las 03:05 de hoy → no corre.
- **Escenario**: son las 03:30 ART y la última corrida fue ayer → corre.
- **Por qué la TZ explícita**: el contenedor de prod corre en **UTC** (gotcha documentado del
  password diario de GR). Derivar la hora con `getHours()` haría que "las 3 de la madrugada"
  cayera a medianoche ART.

### LANE-2.2 — La decisión es una función PURA
La regla de LANE-2.1 DEBE vivir en una función pura `(lastRunAt, now) => boolean`, testeable
sin scheduler ni relojes reales.

## LANE-3 — Un solo carril a la vez

### LANE-3.1 — Exclusión mutua entre carriles
Los dos carriles DEBEN compartir un guard de exclusión: si uno está corriendo, el otro no
arranca y reintenta en su próximo tick.

- **Escenario**: el carril rápido está en vuelo y se dispara el tick del lento.
- **Entonces**: el lento NO llama a GR en ese tick.
- **Por qué**: el carril rápido ocupa ~43 min de cada hora; sin el guard, la corrida diaria del
  lento duplicaría la carga instantánea sobre GR justo cuando el rápido está a mitad de camino,
  y el propio código ya advierte del riesgo de 429s.

## Fuera de alcance (movido a cards propias)

Estos requisitos se ESCRIBIERON en este change y se RETIRARON tras el review. Se
documentan acá para que quede el rastro de por qué:

- **Refresh on-demand del portal** (`GET /api/portal/invoices` y `/me` refrescando
  contra GR antes de responder). Retirado: sin un gate *antes* de llamar a GR, la
  app disparaba **2 llamadas y 2 replace-all concurrentes** sobre las mismas filas
  al abrir Inicio (mide y verifica: `/me` e `/invoices` en paralelo). Y si esa
  transacción choca, queda `lastBalanceAt` sellado fresco con las facturas sin
  escribir — el cliente que pagó no puede forzar refresh por 5 minutos, que es
  justo el bug que veníamos a arreglar. Con los dos carriles andando el peor caso
  de desfasaje ya es ~1 hora.
- **Alarma de staleness del carril lento.** Retirada tras fallar DOS rondas de
  review seguidas: primero se anulaba con el gate del cupo (los dos leían el mismo
  `null` con significados distintos), después con su propia gracia de arranque,
  que se resetea en cada deploy — y ustedes deployan ~52 de cada 60 días, así que
  quedaba muda para siempre. Además era estructuralmente ciega a la inanición del
  guard, que es lo que su propio mensaje mandaba a revisar. **Una alarma rota es
  peor que ninguna: da confianza falsa.**

## PARSE-1 — Un payload no autoritativo de GR nunca se interpreta como "deuda cero"

### PARSE-1.1 — Sobre de error ⇒ TIRA
`parseClientBalanceResponse` DEBE tirar si `root.error` no es `'0'`, si `clientes`
viene vacío, si falta el nodo `cuentas`, o si el input no es un objeto.

- **Por qué**: el `zero` que devolvía viajaba a `upsertInvoices` (replace-all) y
  **borraba todas las facturas del cliente**. Verificado en vivo: GR responde
  **HTTP 200** con `{"error":"90"}` (password diario vencido) y `{"error":"2"}`
  (cliente inexistente), en los dos casos sin nodo `clientes`; y el `deleteMany`
  con lista vacía matchea TODO (medido contra el Prisma de prod: 6 de 6).

### PARSE-1.2 — `debt` sin dato o ilegible ⇒ TIRA
El VALOR también se valida, no solo el contenedor: `debt` ausente, `null`, `''` o
con formato no reconocido DEBE tirar.

- **Escenario**: `debt: "-500 nota de credito"` ⇒ TIRA. (Antes el gate era
  `n === 0` y el gatillo destructivo es `amount <= 0`, así que cualquier basura
  con un menos adelante se salteaba la validación entera.)
- **Medido en vivo**: `debt` viene string en 36/36 clientes, pero sus hermanos del
  MISMO nodo vienen `debt_uss: null` 36/36, `duedebt: ''` 36/36.

### PARSE-1.3 — Formato de plata ambiguo ⇒ TIRA
Un punto seguido de exactamente 3 dígitos sin decimales (`"1.234"`) DEBE tirar
cuando las dos lecturas posibles difieren (1,234 vs 1234) — un error de mil veces
sobre plata. Si coinciden (`"0.000"`), NO tira: rechazarlo dejaría a ese cliente
sin refrescar nunca.

### PARSE-1.4 — La deuda cero LEGÍTIMA se preserva
`error:'0'` + `debt:'0.00'` + `invoices:[]` DEBE seguir devolviendo `amount: 0`
sin tirar, para que el borrado del cliente que pagó todo siga funcionando.

- **Medido**: de 36 clientes reales, 12 tienen deuda 0.
