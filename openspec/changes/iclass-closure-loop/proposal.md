# Proposal — IClass closure loop + OCR + inventario por servicio

> **Status:** PARCIALMENTE IMPLEMENTADO (actualizado 2026-06-01).
> El **closure loop core (vía API v2)** ya vive en `main`. El resto del umbrella (scraper SEAM, fotos, OCR, inventario por servicio, auto-comment) sigue siendo plan.
> Esto es un **umbrella de cambios**; cada feature pendiente será su propio SDD change.

---

## 0. Estado de implementación (2026-06-01)

> Esta sección refleja el CODIGO real en `main`, no la visión. La visión completa (F1-F6) arranca en la seccion 1.

### YA implementado (en `main`)

El **closure loop por API v2** — pull de OS cerradas, mirror y auto-transicion de la task. Es esencialmente F2 reframeada + una pieza nueva (mapeo result-code -> Stage) que no estaba en el plan original.

- **Use case** `IngestClosedServiceOrders` (`src/application/use-cases/`): lista OS terminales (status `7`), matchea `SO.codigo == ScheduledTask.sequenceNumber`, espeja el agregado, y si el result-code esta mapeado a un Stage mueve la task con `moveTaskToStage`. Idempotente por `iclassUpdatedAt`. Watermark vía `SyncState` (entity `iclass-closed`), overlap de 30 min.
- **Use case** `BackfillClosedServiceOrders`: reconcilia las tasks que ya estan en el stage in-flight (`Registrado en IClass`), consultando por `serviceOrderCode` exacto. Reusa `processSummary`.
- **Scheduler** `IClassClosureScheduler` + `bootstrapIClassClosure` (`src/infrastructure/scheduling/`): poll in-process, re-lee el feature flag cada tick, DistributedLock (`iclass-closed`), arranca dormido.
- **Migracion** `20260529210000_iclass_closure_loop`: tablas `IClassServiceOrder`, `IClassSoStatusHistory`, `IClassSoChecklist`, `IClassSoChecklistAnswer`, `IClassSoMaterial`, `IClassSoEquipmentEvent`, `IClassResultCode` (con FK `mappedStageId -> Stage`). Siembra el flag `iclass-closure-loop` en OFF.
- **Tests**: cubren los dos use cases y el scheduler.

### NO implementado (sigue siendo plan)

- **F1 — Scraper SEAM**: no existe. Toda la ingesta es por API v2. NO hay `IClassPortalClient`.
- **Fotos**: NO se ingestan. `IClassSoChecklistAnswer` solo tiene `photoMissing` (boolean), no URL. Sin scraper no hay link a los buckets S3.
- **F3 — Auto-comment en la task**: no existe.
- **F4 — OCR de SN/MAC**: no existe como pipeline. PERO los SN/MAC SI se capturan por otro camino: `IClassSoEquipmentEvent.serialNumber` / `.mac` vienen de los equipment events de la API v2. El OCR solo haria falta para los SN que solo viven en fotos.
- **F5 — Inventario por servicio** (`ServiceInstalledItem`): no existe. Los modelos legacy (`InventoryItem`, etc.) siguen igual.
- **F6 — Sub-tab "Ingesta"** (frontend): no verificable desde este repo; el backend ya expone el mapeo result-code -> stage que la admite.

---

## 1. Por qué este doc existe

El usuario hizo dos descubrimientos importantes durante la sesión que justifican un cambio grande de scope:

1. La investigación del Task #7 (`sdd/iclass-closed-os-ingest-research`) ya documentó la API v2, pero descubrimos que la API v2 es **photo-blind** (no expone fotos ni firmas, sus endpoints `/photos`, `/files`, `/anexos`, `/signatures` devuelven 500).
2. **El portal legacy SEAM (`fs2.iclass.com.br`) SÍ expone las fotos** como links públicos a un bucket S3. Eso destraba el closure loop completo.

A partir de eso, el usuario quiere armar **una integración profunda** que cierre el ciclo:

> "QUE VIVA EN EL MISMO CONFIG DE ICLASS OSEA LA PAGE DE CONFIG, Y MATCHEE CADA X TIEMPO LAS TAREAS QUE ESTEN CERRADAS EN ICLASS Y GUARDE LA DATA EN LA BD DEL HTML, COMENTARIO Y FOTOS, A SU VEZ, HACER UNA FEATURE QUE:
> 1- COLOQUE EN COMENTARIOS DE LA TAREA ASOCIADA EL RESUMEN DE LO QUE USO EL TECNICO
> 2- UN OCR QUE ANALICE LA IMAGEN Y TOME LA SN / MAC DE LAS FOTOS DE LOS ROUTER O ONU
> 3- ESA SN, LO VAS A AGREGAR EN EL CAMPO DE INVENTARIO (QUE TENEMOS QUE HACERLO SIGUIENDO EL DISEÑO DEL FRONT Y USANDO IMPECABLE)
> 4- ALLI VAS A AGREGAR LO QUE SE USO COMO ITEMS NUMERICOS Y DETALLE Y VAS A PONER LA SN O SNS QUE SE VISUALIZARON
> 5- UN BOTON DE AGREGAR SN AL SERVICIO DEL CLIENTE
>
> ASOCIACION SERIA CLIENTE → SERVICIO → ROUTER ANTENA O ONU (PUEDE TENER N ITEMS QUE SERIAN 5 VALORES: ONU, ROUTER, ANTENA, REPETIDOR, OTROS)"

---

## 2. Findings de la sesión (estado actual)

### 2.1 Lo que ya tenemos

- **Envío TO IClass funciona** (`SendTaskToIClass` use case, `IClassClient` adapter en backend). Cada task se manda con su `iclassOrderCode` (el `sequenceNumber`) y queda referenciada por el código de OS de IClass.
- **Project → IClass SO type mapping** ya está (commit `74061770` y siguientes). Cada Project apunta a un `IClassSoType` y eso determina el tipo de OS creado.
- **IClass admin/config page en frontend** ya existe (`SchedulingSettingsPage` → tab "IClass") con 3 sub-tabs: Integración (feature flag), Catálogo (sotypes con sync), Mapeo de proyectos.
- **Sistema de comentarios** rediseñado en Task #14 (commit `0e3aff9`). Cada task admite comments con attachments (URLs) y autor derivado de auth. Ideal para postear el resumen del técnico ahí.
- **Task activity log SDD plan** existe (`sdd/task-activity-log`, commit `e85619a1` en backend main) — listo para apply cuando se decida. NO está implementado.

### 2.2 La API v2 — limitaciones confirmadas

Ver `openspec/changes/iclass-closed-os-ingest-research/proposal.md` y el engram `sdd/iclass-closed-os-ingest-research/explore` (memoria #341) para detalle. Resumen:

- Solo polling — NO webhooks.
- `clusterName=IPNEXT INTERNET` requerido en `GET /serviceorders`.
- Ventana max 30 días, fechas `dd-MM-yyyy HH:mm` (NO ISO).
- En la práctica solo aparece `status.id=7` (Concluida/ENCERRADO) — 239/239 OS en sample de 27 días.
- **Photos: NO existen en v2.** Probado contra todos los paths plausibles, todos 500.
- Sub-resources mayormente 204 (materials, equipments, expenses, environments).
- Rate-limit undocumented: `"Espere um pouco antes de fazer outra requisição"`.
- HATEOAS strings (no objetos), localización inconsistente (PT en history, ES en detail).

### 2.3 Lo nuevo de esta sesión — el portal SEAM

**Hallazgos verificados con Playwright contra producción** (auth `IPNXAUGUSTOH`):

**URL del detail de cierre de una OS:**
```
https://fs2.iclass.com.br/iclassfs/restrict/baixa_os_validada.seam
  ?osId={iclassNumericId}
  &transicaoId=47
  &retornoPriorizacao=false
  &tetrisOnByAction=false
  &source=seam
```

- `osId`: ID numérico de IClass (lo guardamos como `iclassOrderCode` en `ScheduledTask`).
- `transicaoId=47`: action ID — **NO es read-only**, es la página de "Cierre y Baja" (tiene botón "Terminar OS" que ejecuta una acción si se clickea).
- Resto: flags UI.

**El HTML expone 4 secciones:**

1. **Cierre de OS** — Código (nuestro sequenceNumber), Tipo OS, Fecha Program, Técnico, Motivo, Responsable, Relación.
2. **Observaciones e comentarios** — texto libre acumulado.
3. **Encuesta** (el checklist):
   - Preguntas tipo Texto: respuesta libre.
   - Preguntas tipo Foto: **incluyen el link directo a la imagen** en el bucket S3 público.
4. **Adjuntos** — incluye la firma (también S3 público) y otros adjuntos.

**Buckets S3 públicos descubiertos:**

| Tipo | Bucket |
|---|---|
| Fotos del técnico (checklist) | `iclassfs-ipnx.s3-sa-east-1.amazonaws.com` |
| Firma de la OS | `iclassfs-assinatura.s3-sa-east-1.amazonaws.com` |

**Patrón de nombre de foto:**
```
{ddMMyyyy}{HHmmssSS}{counter}_IMG_{yyyyMMdd}_{HHmmssSSS}_{cameraMode}.jpg

Ejemplo:
2052026113938803_IMG_20260520_111407732_MFNR_C.jpg
└─ 2052026 = 20/05/2026 (fecha upload)
└─ 113938803 = 11:39:38.803 (hora upload sub-segundo)
└─ IMG_20260520_111407732 = nombre original cámara
└─ MFNR_C = modo cámara (Motorola PhotoEngine)
```

No tienen pre-signed URL, no expiran, son públicas. Se pueden embeber con `<img src>` o descargar directo.

### 2.4 Riesgos del deep-link directo

- `baixa_os_validada.seam` con `transicaoId=47` muestra un **botón "Terminar OS"**. Si un user lo clickea, ejecuta la acción.
- Hay que **buscar la URL equivalente read-only** (probablemente `consulta_os.seam` o `historico_os.seam` o algo con `transicaoId` distinto). NO se exploró en esta sesión.

### 2.5 Estado del inventario actual

El backend tiene 3 modelos heredados (sin relación a Service):

```prisma
model InventoryItem {
  id, name, category, sku, quantity, minStock, unitPrice, supplier, location, status
}

model InventoryProduct {
  id, name, category, sku, description, unitPrice, supplier, totalStock, minStock, status
  units InventoryUnit[]
}

model InventoryUnit {
  id, productId, serialNumber, barcode, status, location,
  purchaseDate, purchasePrice, assignedToClientId, assignedAt, notes
}

model OnuDevice { ... }   // específico para ONU/GPON
```

**Brecha vs lo que el usuario quiere:**

- No hay relación `Service → InstalledItem[]`. El `InventoryUnit.assignedToClientId` es a cliente, no a servicio.
- No hay tipos enumerados (ONU/Router/Antena/Repetidor/Otros). Hoy es free-text `category`.
- No hay UI por servicio que liste sus items instalados.
- Frontend tiene `InventoryItemsPage`, `InventoryProductsPage`, etc. — son listados globales, no por servicio del cliente.

---

## 3. Lo que querés construir

### Visión: "closure loop" automatizado

```
┌──────────────────────────────────────────────────────────────────┐
│  IClass FS portal (fs2.iclass.com.br)                            │
│  ─────────────────────────────────────                           │
│  Técnico cierra OS → portal recibe fotos + checklist + firma    │
│  Bucket S3 público guarda fotos                                  │
└──────────────────────────────────────────────────────────────────┘
                              ▼
                  (polling cada N minutos)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  ipnext-backend — IClass closure ingest                          │
│  ────────────────────────────────────                            │
│  1. Listar OS cerradas vía API v2 (cluster=IPNEXT INTERNET)     │
│  2. Para cada OS nueva o modificada, scrapear el HTML SEAM       │
│     (login persistente IPNXAUGUSTOH)                             │
│  3. Persistir: SO data + comments + checklist + S3 photo URLs    │
│  4. Match con `ScheduledTask.iclassOrderCode`                    │
└──────────────────────────────────────────────────────────────────┘
                              ▼
                  ┌───────────┴────────────┐
                  ▼                        ▼
┌──────────────────────────────┐ ┌─────────────────────────────────┐
│ Auto-comment en task         │ │ OCR pipeline                     │
│ ─────────────────────        │ │ ───────────                      │
│ - Resumen materiales         │ │ - Extraer SN/MAC de fotos        │
│ - Resumen observaciones      │ │ - Confianza score                │
│ - Link a fotos               │ │ - Almacenar extracción           │
│ - Autor: "Sistema IClass"    │ │                                  │
└──────────────────────────────┘ └─────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Inventario por servicio (nuevo modelo)                           │
│ ─────────────────────────────────────                            │
│  Customer → Service → InstalledItem[]                            │
│                                                                  │
│  InstalledItem {                                                 │
│    type: 'ONU' | 'ROUTER' | 'ANTENA' | 'REPETIDOR' | 'OTROS'   │
│    quantity, description,                                        │
│    serialNumbers: [SN1, SN2, ...] (de OCR + manual),            │
│    sourceTaskId: link a ScheduledTask                            │
│  }                                                               │
│                                                                  │
│  UI: por cada service en customer detail page                    │
│      - Card "Inventario instalado"                               │
│      - Botón "Agregar SN al servicio"                            │
│      - Diseño con impeccable skill                               │
└──────────────────────────────────────────────────────────────────┘
                              ▼
                ┌─────────────┴──────────────┐
                ▼                            ▼
   UI en config IClass page          Frontend customer detail
   ───────────────────────           ────────────────────────
   - 4ª sub-tab "Ingesta"            - Card "Equipos instalados"
   - Estado del scraper              - Por servicio
   - Watermark, last run             - Tipos: ONU/Router/Antena/etc
   - Trigger manual                  - SN/MAC visibles
   - Logs de errores                 - Action: agregar item manual
```

### Las 5 features (breakdown SDD-friendly)

#### F1 — IClass SEAM scraper (backend)
**Scope:** servicio backend que se loguea al portal SEAM y scrapea HTML por OS.

**Componentes:**
- `IClassPortalClient` (nuevo adapter, separado del existing `IClassClient` API client):
  - `login()` — gestiona session cookie del portal
  - `getOSDetailHTML(osId)` — fetch del HTML de la página de cierre
  - `parseOSDetail(html)` — extrae: cierre data, observaciones, checklist (con S3 URLs), adjuntos (firmas)
- **Read-only URL discovery** (TODO antes de scope: encontrar variant del URL que NO sea el de cierre con botón "Terminar OS")
- Credenciales en env (`ICLASS_PORTAL_USER`, `ICLASS_PORTAL_PASSWORD`)
- Backoff y re-login automático si cookie expira

**Dependencia previa:** confirmar URL read-only (no la `baixa_os_validada` con transicaoId=47).

#### F2 — Closure ingest persistence (backend)
**Scope:** modelo Prisma + use case que orquesta v2 API + scraper, guarda en DB.

**Componentes:**
- Modelos Prisma (mismo del Task #7 con ajustes):
  - `IClassServiceOrder` (la principal — ~30 fields)
  - `IClassSoChecklist` + `IClassSoChecklistAnswer` (con `photoUrl: String?` SI scraper la extrajo)
  - `IClassSoStatusHistory` (timeline)
  - `IClassSoAttachment` (signatures + otros adjuntos del portal)
- Use case `IngestClosedServiceOrders`:
  1. Lista OS cerradas vía v2
  2. Para cada nueva o updated (idempotente vía `iclassUpdatedAt`), pega al scraper para fotos/checklist con URLs
  3. Match con `ScheduledTask.iclassOrderCode`
  4. Persist
- Cron entrypoint con watermark per cluster
- Feature flag para rollout controlado

**Conflicto potencial:** el otro agente de RBAC en backend toca `app.ts`. Coordinar.

#### F3 — Auto-comment en task asociada (backend + integración con frontend existente)
**Scope:** cuando un `IClassServiceOrder` cierra y matchea una `ScheduledTask`, postear un comentario automático en esa task.

**Comportamiento:**
- Resumen de checklist Texto answers (materiales, observaciones)
- Links a las S3 photo URLs como attachments del comentario (reusa el sistema de Task #14)
- Autor: usuario sistema (no human user). Definir cómo distinguir en UI.
- Idempotente — no doble-postear si ya existe el comentario.

**Dependencias:**
- F2 (necesita los datos persistidos).
- Task #14 follow-up: cuando se mueva `authorName` resolution a auth context, definir cómo se ve "Sistema IClass" en el author.

#### F4 — OCR para extracción de SN/MAC (backend)
**Scope:** pipeline que toma las fotos del bucket S3 y extrae SN/MAC.

**Decisiones técnicas a tomar:**
- ¿Provider de OCR? Opciones: AWS Textract, Google Vision, Tesseract local, GPT-4 Vision.
- Confianza mínima para auto-accept vs requerir revisión manual.
- Almacenamiento del raw OCR output (para auditoría).

**Componentes:**
- Use case `ExtractDeviceInfoFromPhoto`
- Modelo `OcrExtraction` (per photo: rawText, sn[], mac[], confidence, providerId).
- Trigger: después de F2 ingest, si la pregunta del checklist contiene "MAC" o "SN" o "SERIAL" en su texto.
- Almacena los SN/MAC extraídos linkeados al `ScheduledTask` para que F5 los use.

#### F5 — Inventario por servicio (frontend + backend)
**Scope:** modelo nuevo + UI por service en customer detail, con botón "Agregar SN al servicio".

**Backend:**
- Modelo nuevo `ServiceInstalledItem`:
  ```prisma
  model ServiceInstalledItem {
    id              String   @id @default(uuid())
    serviceId       String
    service         Service  @relation(fields: [serviceId], references: [id])
    type            String   // enum: ONU | ROUTER | ANTENA | REPETIDOR | OTROS
    quantity        Int      @default(1)
    description     String?
    serialNumbers   String[] // SN/MAC values, array (puede tener varios)
    sourceTaskId    String?  // qué task del scheduling lo instaló
    sourceTask      ScheduledTask? @relation(fields: [sourceTaskId], references: [id])
    addedAutomatically Boolean @default(false)
    notes           String?
    createdAt       DateTime @default(now())
    updatedAt       DateTime @updatedAt
    @@index([serviceId])
  }
  ```
- Use cases:
  - `ListServiceInstalledItems(serviceId)`
  - `AddInstalledItem(serviceId, data)`
  - `UpdateInstalledItem(id, data)`
  - `RemoveInstalledItem(id)`
  - `AddSerialToService(serviceId, type, sn)` — atajo del "agregar SN al servicio"
- Route: `/api/customers/:customerId/services/:serviceId/inventory`
- Trigger del scraper (F4): cuando OCR extrae SN, propone añadirlo (NO auto-attach — requiere confirmación humana).

**Frontend:**
- En customer detail page, por cada service: card "Inventario instalado"
  - Lista de items por type con qty + SN
  - Botón "Agregar SN al servicio del cliente" — modal compositor (type dropdown, qty, sn input, notes)
  - Pre-fill de SN cuando viene de OCR (con badge "Sugerido por OCR")
- Diseño con `impeccable` skill (mismo lineamiento que IClass settings)
- Tests Vitest

**Hooks:**
- `useServiceInstalledItems(serviceId)`
- `useAddInstalledItem`, `useUpdateInstalledItem`, `useRemoveInstalledItem`

#### F6 — Sub-tab "Ingesta" en IClass settings page (frontend)
**Scope:** admin UI dentro de la tab IClass existente.

**Componentes:**
- 4ª sub-tab "Ingesta de cierres" en `IClassSettingsBody`
- Muestra: estado del scraper (running/stopped), last run, próximo run, watermark actual, errores recientes
- Botones: "Sincronizar ahora", "Reset watermark", toggle feature flag
- Tabla de últimos N ingests con OS code + matched task + status

**Dependencias:**
- F1, F2 (sin el scraper no hay nada que mostrar).

---

## 4. Orden recomendado de implementación

1. **F0 (pre-trabajo, NO scope SDD)**: explorar el portal SEAM con Playwright/cookies para encontrar la URL read-only equivalente a la de cierre. Sin esto, F1 no debería commitearse a un endpoint riesgoso.
2. **F5 frontend solo (modelo + UI + manual SN add)** — primero el inventory feature sin OCR ni scraper. Útil de inmediato (los técnicos pueden cargar SN manualmente). Frontend tiene el `impeccable` design ya validado.
3. **F1 + F2** — scraper + persistencia. Esto trae las fotos y datos a la DB.
4. **F4** — OCR. Decisión de provider primero (costo + accuracy).
5. **F3 + F6** — auto-comment + UI de monitoreo del scraper. Cierran el loop visible al usuario.

**Razón:** F5 manual primero te da valor inmediato. Las otras 4 son pipelines automatizadas que dependen entre sí.

---

## 5. Riesgos y open questions

### Técnicos
- **El HTML del portal SEAM puede cambiar sin aviso.** Mitigación: tests de scraping basados en HTML snapshot, alerta cuando el parser falla.
- **Auth del portal SEAM**: sessions expiran. Mitigación: re-login transparente + caché de cookie.
- **Rate limit**: el portal puede limitar requests. Mitigación: backoff exponencial + jitter.
- **OCR costo**: cada foto procesada cuesta. ¿Procesamos TODAS o solo las preguntas que matchean keyword "MAC"/"SN"?
- **Bucket S3 público**: hoy es público. ¿Si IClass cambia a private/signed? Mitigación: dejar el download del scraper como source of truth y opcionalmente espejarlas a nuestro propio bucket.
- **`assinatura` bucket**: firmas pueden ser sensibles (signatures = datos personales). Decidir si las descargamos o solo guardamos URL.

### Producto / decisión humana
- **¿URL read-only en SEAM?** — sin esto F1 es riesgoso. Tarea exploratoria pre-SDD.
- **OCR provider** — AWS Textract vs Google Vision vs OpenAI Vision vs Tesseract local. Tradeoff costo/accuracy/dependencias.
- **¿Auto-attach SN al servicio o requerir confirmación?** — el usuario sugiere "botón de agregar". Sugiere confirmación humana siempre.
- **¿Qué hacer con OS cerradas que no matchean ninguna task local?** — ignorar, alertar, o crear task post-hoc.
- **Existing inventory models** (`InventoryItem`, `InventoryProduct`, `InventoryUnit`) — ¿coexisten con `ServiceInstalledItem` o se refactorea? Recomendación: coexisten. Los legacy son stock-keeping global, `ServiceInstalledItem` es lo instalado en una service específica.

### Coordinación con otros agentes
- El otro agente está en `auth-rbac-foundation` (backend). F2/F5 tocan `app.ts` (DI wiring). Esperar a que cierre RBAC o coordinar el merge.

---

## 6. Tracking

Crear estos engram topic keys cuando arranquemos cada fase:

- `sdd/iclass-portal-readonly-url/explore` — F0 (pre-trabajo)
- `sdd/iclass-portal-scraper/*` — F1
- `sdd/iclass-closed-os-ingest-persist/*` — F2 (reemplaza el viejo `iclass-closed-os-ingest-research` que era research-only)
- `sdd/iclass-auto-comment-task/*` — F3
- `sdd/iclass-ocr-sn-mac/*` — F4
- `sdd/service-installed-items/*` — F5
- `sdd/iclass-ingest-admin-ui/*` — F6

---

## 7. Pendiente de decidir antes de arrancar

1. **¿Empezamos por F5 (inventario manual sin OCR)** o vamos derecho al scraper?
2. **¿Tenemos presupuesto para OCR cloud** (Textract / Vision / OpenAI) o vamos con Tesseract local?
3. **¿Las firmas se descargan o solo se referencian** (datos sensibles)?
4. **¿Esperamos a que el otro agente cierre auth-rbac** antes de tocar backend, o coordinamos un merge cuidadoso?

---

> Cuando quieran arrancar, este doc + los engram artifacts del Task #7 son toda la base. Cada feature es un SDD change independiente.
