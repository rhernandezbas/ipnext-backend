# Tasks — `ai-assistant-multiagent`

TDD estricto: **el test que falla primero, después el fix.** Cada tarea referencia el requisito del
`spec.md` que la justifica. Los use cases se testean con adapters **in-memory** (nunca mockeando
Prisma).

Gate por batch: `npm test` completo + `tsc --noEmit`, corridos por el orquestador.

---

## Batch 1 — Modelo de datos y catálogos (fundación)

- [ ] **T1.1** `AssistantProfile` + `AssistantIntent` + `AssistantDataSource` + `AssistantAction` +
      `AssistantRun` en `prisma/schema.prisma` (D5) · `generatedByAssistant` en `ChatMessage` y
      `TicketComment` (OBS-2)
- [ ] **T1.2** Migración **aditiva** generada con `migrate diff --from-schema/--to-schema` (sin DB
      local) + **seed idempotente de los dos catálogos** en la misma migración
      (`ON CONFLICT (key) DO NOTHING`) — `noc.cortes` con `enabled:false` (D2)
- [ ] **T1.3** Ports `AssistantProfileRepository` / `AssistantIntentRepository` /
      `AssistantCatalogRepository` / `AssistantRunRepository` (`domain/ports/`)
- [ ] **T1.4** Adapters `InMemory*` de los 4 ports + sus tests
- [ ] **T1.5** Adapters `Prisma*` de los 4 ports (naming `Prisma{Entity}Repository`)
- [ ] **T1.6** Entidades de dominio + DTOs (`application/dto/`) — **jamás devolver entidad Prisma**

## Batch 2 — Configuración editable (CFG)

- [ ] **T2.1** `CreateAssistantProfile` / `UpdateAssistantProfile` / `GetAssistantProfile` /
      `ListAssistantProfiles` — **CFG-1**: `enabled` default `false`; cascade al borrar el área
- [ ] **T2.2** `CreateAssistantIntent` / `UpdateAssistantIntent` / `DeleteAssistantIntent` /
      `ListAssistantIntents` — **CFG-2**: alta/baja sin deploy; `@@unique([profileId,name])`
- [ ] **T2.3** Validación de `dataSourceKeys[]` y `actionKey` contra los catálogos → **400** si la key
      no existe (**CFG-3**) · MUST NOT existir endpoint para CREAR fuentes o acciones
- [ ] **T2.4** `ListAssistantDataSources` / `ListAssistantActions` (catálogos, read-only + toggle
      `enabled`)
- [ ] **T2.5** Rutas `assistant.routes.ts` con guard granular `assistant:read` / `assistant:manage`
      (**D7**) + permisos en el catálogo RBAC del BE
- [ ] **T2.6** Feature flag `ai-assistant-enabled` (seed **OFF**) — **RUN-4**, leído por invocación

## Batch 3 — Registry de datos y contexto sin PII (SEC-1)

- [ ] **T3.1** Port `AssistantDataSourceRegistry` + tipo `AssistantSubjectContext` que **NO declara
      campos de identidad** (**SEC-1** garantizada por compilación, D2)
- [ ] **T3.2** Resolvers `cliente.saldo`, `cliente.servicio`, `os.abiertas`, `ticket.resumen`,
      `noc.cortes` + tests: cada uno devuelve **sólo hechos**
- [ ] **T3.3** Test que falla si el payload hacia el port contiene nombre/DNI/domicilio/email/teléfono
- [ ] **T3.4** Redactor de PII del mensaje entrante (DNI/CUIT/email) + test de cobertura parcial
      **documentada** (SEC-1, scenario 2)
- [ ] **T3.5** Fuente deshabilitada en catálogo ⇒ se omite con warn, el resto del contexto se arma
      igual (CFG-3, scenario 2)

## Batch 4 — Motor (RUN + RTR + SEC)

- [ ] **T4.1** Port `AssistantRuntime` — contrato **MUST NOT throw** (**RUN-1**, molde
      `InstallationAuditor`)
- [ ] **T4.2** Guardas previas, **funciones puras testeables sin modelo**: SEC-2 (anti-loop:
      `inbound` + `!private`), SEC-5 (opt-out), SEC-3 (`canReply`), RUN-4 (flag global)
- [ ] **T4.3** Paso 1 — clasificador: universo = intents `enabled` **del perfil del área**
      (**RTR-2**, aislamiento entre perfiles); devuelve key del set cerrado o `null`
- [ ] **T4.4** Paso 2 — decisión en **código**: intent existe/enabled, acción habilitada
      (**ACT-1**), default deny (**RTR-3**)
- [ ] **T4.5** Paso 3 — resolución de `dataSourceKeys` de la intent ganadora
- [ ] **T4.6** Paso 4 — redacción + centinela `NO_PUEDO_RESPONDER` (**D8**)
- [ ] **T4.7** Paso 5 — **verificador de números (SEC-4, D3)**: whitelist de literales, extracción de
      secuencias ≥3 dígitos, rechazo ⇒ handoff. Tests del caso `45000` vs `54000`, formatos
      `45.000`/`45,000`, y de la limitación documentada (números en letras)
- [ ] **T4.8** Port `AssistantSubjectGateway` + `ConversationSubjectGateway` (→ `SendMessage`,
      `SetConversationArea`) y `TicketSubjectGateway` (→ `AddTicketComment`, `UpdateTicket`) —
      **RUN-3**: cero acceso directo a `ChatwootGateway` ni a repos de mensajes (D4)
- [ ] **T4.9** Use case `ReplyWithAssistant` orquestando 1→6, **sin una sola intención hardcodeada**
- [ ] **T4.10** **RTR-1**: sin área ⇒ clasificar + `applyArea` ⇒ evento `area_changed` con
      `actorId:null`

## Batch 5 — Adapter DeepSeek

- [ ] **T5.1** `HttpDeepSeekAssistant` en `infrastructure/adapters/deepseek/` — **el ÚNICO archivo
      del repo que nombra a DeepSeek**
- [ ] **T5.2** Config fail-fast en `infrastructure/config.ts` (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`,
      modelos por defecto, timeout) + `env.example`
- [ ] **T5.3** Tests: timeout / 4xx / 5xx / JSON malformado ⇒ **no-op**, nunca throw (RUN-1)
- [ ] **T5.4** `gh secret set DEEPSEEK_API_KEY` + línea `-e DEEPSEEK_API_KEY` en el step
      `Deploy container` de `deploy.yml` *(lección: los gates mockean HTTP y NO cazan env faltante en
      prod)*

## Batch 6 — Enganches y wiring

- [ ] **T6.1** Rama best-effort en `ReceiveChatwootWebhook` (molde `captureAttachments`) — **RUN-2**:
      el webhook ackea 200 aunque el asistente reviente
- [ ] **T6.2** Rama best-effort en `CreateTicket` y `AddTicketComment` — el ticket/comentario se crea
      igual (RUN-2)
- [ ] **T6.3** Wiring completo en `app.ts` (**D6**) + **composition-root test** con assertions
      estáticas sobre el fuente *(bug W6: rutas cableadas, hook no inyectado ⇒ feature muerta en prod
      con CI verde)*
- [ ] **T6.4** **Test de seam completo** (lección #28/#27): mensaje → webhook → motor → gateway →
      salida, con use case REAL y repos in-memory, **sin mockear el use case**

## Batch 7 — Auditoría (OBS)

- [ ] **T7.1** Persistir `AssistantRun` en toda invocación (replied/handoff/noop/rejected/error) —
      **OBS-1**, sin PII ni prompt crudo
- [ ] **T7.2** `generatedByAssistant` seteado en la salida + expuesto en los DTOs de mensaje y
      comentario — **OBS-2** (marca persistida, no heurística)
- [ ] **T7.3** `ListAssistantRuns` con filtros (área, outcome, rango) + ruta con `assistant:read`

## Batch 8 — Evaluación (EVAL)

- [ ] **T8.1** Script de extracción del eval set desde `Conversation`/`ChatMessage` reales, con
      **anonimización**, en dos particiones: resolución y abstención (**EVAL-1**)
- [ ] **T8.2** Runner del eval: reporta **resolution accuracy** y **tasa de abstención correcta**
      por separado, y persiste la corrida
- [ ] **T8.3** **EVAL-2** — gate: habilitar una acción `riskLevel:'red'` sin corrida registrada ⇒
      rechazo con motivo
- [ ] **T8.4** **ACT-2** — test del seed conservador: ninguna acción `red` habilitada en instalación
      nueva

## Batch 9 — Frontend

- [ ] **T9.1** Correr `ui-ux-pro-max --design-system` **antes** de escribir UI; motion con las skills
      de Emil
- [ ] **T9.2** Sub-página Config → Asistente IA: lista de áreas + editor de perfil (**D9**)
- [ ] **T9.3** CRUD de intenciones con selector múltiple de fuentes — `Select`/`Combobox` **propio**,
      jamás nativo
- [ ] **T9.4** Chips de riesgo + **doble confirmación con impacto explícito** al habilitar una acción
      `red`
- [ ] **T9.5** Marca del mensaje generado por el asistente en el hilo y en el ticket (OBS-2)
- [ ] **T9.6** Página de corridas (`AssistantRun`) para auditar qué hizo cada agente
- [ ] **T9.7** `RequirePermission assistant.read` + `Can assistant.manage`; tokens `var(--color-*)`,
      4 ramas de estado, contraste ≥4.5:1 **calculado**, touch ≥44px

## Batch 10 — Cierre

- [ ] **T10.1** Gate completo: suite BE + `tsc --noEmit` · suite FE + typecheck + build
- [ ] **T10.2** **Review adversarial** (obligatorio): focos separados —(a) SEC-1/SEC-4 y fuga de
      datos, (b) anti-loop y concurrencia, (c) wiring/contrato BE↔FE, (d) tests y cobertura del seam
- [ ] **T10.3** Fix wave con TDD + **re-review focalizada** hasta **CLEAN**
- [ ] **T10.4** `sdd-verify` — matriz de spec-compliance: cada scenario con su test verde
- [ ] **T10.5** Deploy **dark** (flag OFF, cero perfiles habilitados) + confirmar el run en `gh`
- [ ] **T10.6** Encendido gradual: 🟢 `comment_internal` en UNA área → medir → 🟡 `whatsapp_reply` →
      🔴 sólo con eval (EVAL-2)

---

## Orden y dependencias

```
B1 ─► B2 ─┐
          ├─► B4 ─► B6 ─► B7 ─► B10
B3 ───────┘        ▲
B5 ────────────────┘
B8 y B9 en paralelo con B6/B7
```

**B1 es bloqueante de todo.** B3 y B5 pueden ir en paralelo con B2. B9 (FE) necesita los DTOs de B2
congelados: el **contrato BE↔FE va explícito campo por campo** en ambos lados *(lección W6: FE y BE
construidos en paralelo desde el spec driftaron y la página renderizó filas en blanco)*.
