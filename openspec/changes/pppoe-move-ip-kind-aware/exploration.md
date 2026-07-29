# Exploración: el move de PPPoE ignora la clase de IP del NAS destino

> Todo lo de acá está **verificado en código y en la DB de producción** el 2026-07-29.
> Origen: el usuario intentó mover `EnzoBianchiCh` (CGNAT en CANEPA) al NE8000 eligiendo
> "Pública" y recibió `El NAS destino no tiene pool CGNAT configurado.`

## El síntoma reportado

Modal "Internet — PPPoE" de un contrato. Estado actual del servicio:

```
usuario   EnzoBianchiCh
perfil    IP-Air-30-30
router    CANEPA/Ovoprot/Cargi/Mitre/Garelli/indacochea
IP remota 100.64.60.200  (fija)
```

El operador elige **Tipo de IP = Pública**, **Router = NE8000 - Mercedes**, el botón
"Auto-asignar IP" le sugiere `190.7.229.90` (válida: del pool `arzobispado-public`, que hoy
cuelga del NE8000) y al guardar aparece el error de pool CGNAT.

**El mensaje NO es un bug de texto en este caso: el backend REALMENTE pidió un pool `cgnat`.**
(La primera lectura de que el mensaje era contradictorio fue incorrecta y se descartó.)

## Hallazgo 1 — el move hardcodea `cgnat` (la causa raíz)

`src/application/use-cases/MovePppoeToNas.ts:175`

```ts
const poolType = esAdopcion ? s.ipTypePreference : 'cgnat';
```

Solo la **adopción** de un pendiente respeta el `ipTypePreference` persistido. Un move
NORMAL pide **siempre** un pool `cgnat` del destino. Está declarado como intencional en el
doc de la ruta (`pppoe.routes.ts:8`: *"radius-aware: IP nueva del pool cgnat del destino"*)
— era la semántica de la W1 cuando TODO era CGNAT.

## Hallazgo 2 — el NE8000 ya no tiene pools CGNAT (por qué explota AHORA)

Query a la DB de prod (`bd_owners_splynx-repli`, base `test`):

| NAS | pools cgnat | pools public | servicios |
|---|---:|---:|---:|
| **NE8000 - Mercedes** | **0** | 18 | **3272** |
| CANEPA/Ovoprot/... | 3 | 0 | 678 |
| RDA Agote Gownland | 3 | 2 | 590 |
| Vialidad/LaRica/Tomaso | 2 | 3 | 403 |
| Ugarte/9 de julio | 2 | 0 | 276 |
| Parque Industrial/... | 2 | 0 | 249 |

⇒ **NO se puede mover NINGÚN servicio al NE8000 desde la UI.** Falla siempre, para cualquier
cliente, con cualquier tipo elegido. Y el NE8000 concentra **3272 de los 5468 servicios** de
la red: es el BRAS al que se está migrando todo (cutovers Arzo/Estudiantes/Hípico/Acceso Sur
+ la fibra de RDA2). No es un caso borde, es la operación principal muerta.

La migración de pools CGNAT→públicas del NE8000 (07-13 a 07-22) dejó el use case obsoleto
**sin que nada lo detectara**: los tests pasan porque ejercitan NAS con pools cgnat.

## Hallazgo 3 — el `ipTypePreference` NUNCA se persiste desde el modal de edición

`ipnext-frontend/src/pages/customers/tabs/contracts/InternetPanel.tsx:824`

```ts
const updateBody: { password?: string; remoteAddress?: string } = {};
if (editForm.password) updateBody.password = editForm.password;
if (editForm.remoteAddress !== (pppoe.remoteAddress ?? '')) updateBody.remoteAddress = ...;
```

El body solo lleva **password** y **remoteAddress**. El toggle `Privada/Pública` del form de
edición solo alimenta el `useNextFreeIp` (qué pool consultar para SUGERIR una IP): la
elección **jamás sale al backend**. Y el move se llama con `{ id, nasId }` únicamente
(línea 816) — el wire no tiene forma de expresar la clase de IP destino.

⇒ Hoy **es imposible cambiar el tipo de IP de un servicio desde ese modal**, aunque el botón
se pinte y el sugeridor devuelva una IP pública coherente. La UI ofrece una combinación que
el API no sabe ejecutar.

## Hallazgo 4 — el mensaje del FE aplana el tipo de pool

`ipnext-frontend/src/utils/mapPppoeMoveError.ts:36`

```ts
case 'NO_POOL_FOR_NAS_TYPE':
  return 'El NAS destino no tiene pool CGNAT configurado.';
```

El error del dominio está parametrizado (`El NAS ${nasId} no tiene un pool '${type}'`, con
`type` = `cgnat` | `public`) pero el FE hardcodea "CGNAT". Hoy acierta por casualidad; en el
camino de adopción, donde `poolType` puede ser `public`, mentiría.

## Hallazgo 5 — gotcha del provider: no acoplar los pools al orchestrator

`src/application/services/NasLiveStatsProvider.ts:59-95` es el lugar natural para exponer las
clases soportadas (ya carga los pools en la línea 69, y ya tiene el molde de campo aditivo de
presentación con `displayType`). **Pero el orden importa:**

```ts
const pools = await this.ipNetworkRepo.findPoolsByNas(nas.id);  // 69 — DB, confiable
const sessions = await this.fetchAllSessions();                 // 70 — orchestrator, falible
} catch { return { ...nas, displayType }; }                      // 91 — se pierde TODO
```

Si `supportedIpKinds` se calcula dentro de ese `try`, **desaparece cada vez que el RADIUS esté
caído**, aunque los pools se hayan leído bien. Con los tipos ausentes el FE esconderría ambos
botones y bloquearía la operación por una causa no relacionada. Debe ir en su propio
try/catch, independiente del orchestrator.

Segundo detalle: la línea 63-64 retorna temprano para NAS que no rutean por el orchestrator,
**sin cargar pools**. Hoy los 6 NAS son `radius_orchestrator` así que en la práctica todos
pasan, pero el cálculo no debe depender de ese early-return.

## Decisiones del usuario (2026-07-29)

1. **Al mover un CGNAT a un NAS que solo acepta públicas: CONVERTIR** — asignar la primera IP
   libre de un pool público del destino y actualizar el `ipTypePreference` a `public`. Un solo
   paso. (Descartados: bloquear y exigir cambio previo; doble confirmación en el modal.)
2. **SDD completo** con plan a confirmar antes de implementar.
3. Idea original del usuario, aceptada: **detectar qué clases acepta cada NAS y esconder en el
   FE los tipos no soportados.** Se incorpora, con la aclaración de que el FE es comodidad y el
   BE es la autoridad (regla de las dos capas del workflow).
