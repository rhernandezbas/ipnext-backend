# Deudas pendientes — Prominense

> Última actualización: 2026-05-27
> Repos: `ipnext-backend` (BE) · `ipnext-frontend` (FE)
> Estado: lo que está hecho **no** figura acá. Esto es solo lo que QUEDA.

---

## 🔒 Seguridad / acción del usuario (URGENTE)

- [ ] **Revocar el PAT de GitHub** `ghp_GDHPEtPhz0...` usado para cargar los GitHub Secrets.
  → github.com/settings/tokens. Ya cumplió su función.
- [ ] **Credenciales hardcodeadas en el skill `gestion-real-ipnext`** (CUIT `30708499850`, SECRET `IPNEXT@2023`).
  Viven en texto plano en el `SKILL.md`. Evaluar moverlas a variables/secret manager.
- [ ] **No hay enforcement de roles/permisos en el backend.** Los roles son editables
  (`AdminRoleDefinition`) pero NUNCA se chequean server-side: el auth middleware solo valida
  el token. El botón "Eliminar tarea" se gatea SOLO en el front por rol → no es seguridad real.
  Pendiente: la página de permisos + enforcement en backend (el usuario lo hará después).

---

## 🔴 Funcionales pendientes

- [ ] **Sincronizar facturas de Gestión Real** (candidato SDD `gr-invoices-sync`). **[BE+FE]**
  El tab Facturación ("Saldo pendiente") suma la tabla `Invoice` local, que está en **0** porque
  no traemos las facturas de GR → un deudor muestra $0 pendiente, inconsistente con `balanceDue`.
  La data YA la fetcheamos: la acción `cliente` de GR devuelve `cuentas.invoices[]`
  (importe, saldo, fecha_vto, url_pdf, link de pago MercadoPago) en el mismo payload del saldo.
  Solo falta persistirlas en `Invoice` durante el balance refresh.

- [ ] **Replies de tickets siguen in-memory.** **[BE]**
  El change `tickets-model` migró el modelo de tickets a Prisma, pero los `ticketRepliesStore`
  (respuestas) quedaron out-of-scope, todavía en memoria en `tickets.routes.ts`.
  Pendiente: modelo `TicketReply` con FK a `Ticket`.

- [ ] **Integración de `casos` de GR como tickets.** **[BE]**
  El modelo `Ticket` tiene `grCasoId` reservado pero sin lógica. A futuro: traer los reclamos/casos
  de GR (acción `casos`) y mapearlos a tickets.

- [ ] **lat/lng no viaja en el alta de tarea.** **[FE]**
  Al CREAR una tarea con un servicio, solo se carga la dirección (texto); las coordenadas
  (lat/lng) del servicio NO se mandan en `CreateTaskPayload` (el detalle sí las setea).

---

## 🟡 Deuda técnica

- [ ] 🔒 **Leak de secretos NAS en prod (`radiusSecret`/`apiPassword` crudos).** `GET /api/nas-servers` (ListNasServers) y `GET /api/nas-servers/:id` (GetNasServer) devuelven la entidad `NasServer` CRUDA con `radiusSecret`/`apiPassword` reales — `PrismaNasRepository.toEntity` NO enmascara. Los tests NO lo cazan porque `InMemoryNasRepository` seedea `'••••••••'` (oculta el leak; el comentario "masked in responses" en `domain/entities/nas.ts` es aspiracional, no real). Gateado por `network.read`/`network.manage` (no público, pero el secreto viaja a cualquier operador de red y puede loguearse/cachearse). **Fix:** enmascarar en los use cases/rutas (helper compartido, convención `'••••••••'`) — igual que ya hace la ruta `pool-mode` (commit `83e1c245`). Descubierto en el review adversarial del sqlippool BE (2026-06-27). Cambio chico + review enfocado. **Verificar en vivo antes** (curl a `/api/nas-servers` en prod) para confirmar que no hay otro masking en el medio.
- [ ] **16 tests pre-existentes rotos en el frontend** (NO introducidos esta sesión, confirmado con git stash):
  - `CustomerDetailPage.test` / `ClienteDetailPage` (~7)
  - `CreateTicketPage.test` (~6)
  - `InfoTab.test` — "renders customer fields" + "map iframe" (2)
  - `Sidebar.test` (1)
- [ ] **Logging `prisma:query` verboso en producción.** Llena los logs y cuesta algo de
  performance. Bajar el log level de Prisma en el entorno prod.
- [ ] **`prismaClientLookup` ya tipado**, pero revisar si quedan otros `as any` o `new GlobalSearch()`
  sin puerto (hallazgo del arquitecto backend).

---

## 🧹 Cosmético / menor

- [ ] **Tabs de estado de la lista de tickets desalineadas.** **[FE]**
  `TicketsListPage` muestra tabs `Abierto / En progreso / Resuelto / Cerrado` (vocabulario viejo de 4),
  pero el backend canónico es `open | pending | closed` (3). El tab "Resuelto" no matchea nada.
- [ ] **Migrar el contador de deudores a una card/badge visible** (idea ofrecida, no pedida).

---

## 🗂️ Datos de prueba dejados en prod (limpiar cuando se quiera)

- [ ] Tarea **#4273** "Verificación servicio + contador" (cliente ABALO ALFREDO) — cerrada.
- [ ] Ticket **"Ticket de prueba"** (cliente CARLE ALICIA) — creado para verificar el contador.

---

## 📐 Planes SDD ya ejecutados (referencia — NO pendientes)

Archivados en `openspec/changes/archive/` y `openspec/changes/`:
deprecated-cleanup, frontend-routing-nested, naming-es-en-convention, task-service-location,
gr-client-balance-sync, tickets-model.

---

## 🏗️ Limitaciones conocidas (por diseño, no necesariamente a resolver)

- El scheduler de GR es in-process con **lock distribuido** (Postgres advisory lock) → seguro con
  N réplicas. Si algún día se escala mucho, evaluar un worker dedicado.
- GR no tiene delta global de contratos: se sincronizan por cliente tocado + barrido inicial.
- El saldo deudor (`balanceDue`) solo se puebla para deudores (estado 2), vía refresh
  on-demand (TTL 60m) + batch horario.
