# Design — messaging-inbox-v2 · Grupo B: Contexto rico del cliente (F1.5) — FRONTEND

> Fase `sdd-design`, **Grupo B, foco FRONTEND**. Diseña el rediseño de
> `ClientContextPanel` (la 3ra columna del inbox) para pasar de "nombre + link"
> a un **resumen accionable** del cliente. Consume el endpoint lazy nuevo del BE
> (`GET /api/messaging/conversations/:id/client-context`, ver `proposal.md`
> §What/Decisión 3) vía un 2do fetch separado del detalle.
>
> Principio rector (heredado del arquitecto, `proposal.md`): **el panel es un
> RESUMEN, NO un clon de la ficha.** Secciones compactas + links a la ficha
> existente (`/admin/customers/view/:id`) para el detalle. READ-ONLY.
>
> Repos: FE `ipnext-frontend`, BE `ipnext-backend`. Este doc vive en el BE
> (junto a los otros artefactos), pero TODO el cambio que describe es del FE.

---

## 0. Skills de diseño usadas (obligatorio, confirmado)

**`ui-ux-pro-max` — corrida.** Script `search.py "...customer context panel debt
status badges CRM sidebar" --design-system`. Resultado anclado: tipografía
**Inter** (ya es el `--font-family` del repo, ✓), patrón "Real-Time Monitoring",
paleta status-green para el estado positivo, y el **checklist pre-entrega** que
adopto entero: no emojis como íconos (SVG Heroicons/Lucide), `cursor:pointer` en
clickables, hover 150–300ms, **contraste 4.5:1**, focus visible, `prefers-reduced-motion`,
responsive 375/768/1024/1440. El script sugiere un theme OLED dark; **NO lo aplico**
— el panel admin de Prominense es light y tiene su propio design system tokenizado
(`src/tokens/variables.css`); la recomendación de dark-mode del script se descarta
por cohesión (romper el lenguaje visual del panel sería peor que "seguir la moda").
Lo que SÍ tomo: la disciplina de contraste, focus y motion del checklist.

**Skills de animación de Emil — leídas (las 5, en `ipnext-frontend/.agents/skills/`):**
- **`emil-design-eng/SKILL.md`** — framework de decisión de animación (¿anima?
  → frecuencia; propósito; easing; duración <300ms), stagger (30–80ms), blur para
  enmascarar crossfades, `scale(0.97)` en press, curvas custom, `@starting-style`,
  "solo transform/opacity", reduced-motion "menos, no cero".
- **`apple-design/SKILL.md`** — Response (feedback en pointer-down, matar latencia),
  springs (damping 1.0 default), spatial consistency, jerarquía por peso tipográfico,
  tracking size-specific, reduced-motion como cross-fade.
- **`animation-vocabulary/SKILL.md`** — glosario: *Stagger*, *Crossfade*, *Skeleton/Shimmer*,
  **Tabular numbers**, *Number ticker*, *Accordion/Collapse*, *Press feedback*.
- **`improve-animations/SKILL.md`** y **`review-animations/SKILL.md`** — el catálogo
  de reglas (STANDARDS) que uso como checklist adversarial de las animaciones de acá
  abajo (§8): sin `transition:all`, sin `scale(0)`, sin `ease-in` en UI, sub-300ms,
  origin-aware, interrumpible, GPU-only, reduced-motion, timing asimétrico, cohesión.

Aplico las curvas de Emil **reusando el token que el inbox YA declara**:
`--wa-ease-out: cubic-bezier(0.23, 1, 0.32, 1)` (presente en `ConversationListItem.module.css:12`
y `MessageBubble.module.css`) — que es EXACTAMENTE el "Strong ease-out" del SKILL de
Emil (`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`). Cero curva nueva inventada.

---

## 1. Árbol de componentes (container-presentational estricto)

Hoy `ClientContextPanel` es **presentacional puro** (recibe `clientContext` por
prop, sin hooks) y la única "container" del inbox es `WhatsappInboxPage`. Este
diseño hace un **cambio deliberado y acotado**: `ClientContextPanel` pasa a ser
un **container fino** que posee el 2do fetch lazy. Justificación: el dato del
panel es **autocontenido y lazy** (solo se pide al haber match, y aun así aparte
del hot path del detalle, `proposal.md` Decisión 1) — meterlo en la page inflaría
el container global con estado (`chosenClientId`) que solo el panel usa. El
container queda ultra-fino: hook + 1 pieza de estado local + switch de estados.

```
WhatsappInboxPage (container global — ya existe)
│  detail = useWhatsappConversation(selectedId)      // trae clientContext LIGHT (instant)
│  <ClientContextPanel
│     conversationId={selectedId}
│     lightContext={detail?.clientContext} />        // status + clients[] ya resueltos
│
└─ ClientContextPanel  ← CONTAINER FINO (reescritura de components/ClientContextPanel.tsx)
   │  · deriva el estado del panel de lightContext.status (matched/ambiguous/unknown/ausente)
   │  · estado local: const [chosenId, setChosenId] = useState<string|null>(null)
   │  · llama useInboxClientContext(conversationId, effectiveClientId)  ← hook nuevo (§3)
   │      enabled solo si status==='matched' || (status==='ambiguous' && chosenId)
   │  · NO renderiza markup rico: delega en presentacionales puros por estado ↓
   │
   ├─ (ausente | unknown)      → <ContextNeutral message=…/>            (puro, ya existe la idea)
   ├─ (ambiguous, sin elección)→ <CandidatePicker clients onChoose=setChosenId/>  (puro)
   ├─ (loading rico)           → <ContextSkeleton/>                     (puro; reserva alto exacto)
   ├─ (error sin data)         → <ContextError onRetry=refetch/>        (puro)
   └─ (matched | elegido, data)→ <MatchedClientView client isRefreshingBalance/> (puro)
        │
        ├─ <IdentityHeader   client/>        // nombre + StatusBadge + link ficha
        ├─ <FinancialSection client isRefreshingBalance/>  // HERO: deuda + últ. factura + próx. venc.
        ├─ <ServiceSection   contracts/>      // por contrato: plan/tecnología/dirección + serviceStatus
        └─ <InteractionsSection client/>      // tickets abiertos (count+N) · tareas N · logs N
```

**Regla de módulos CSS (gotcha del repo).** Vitest corre con
`classNameStrategy:'non-scoped'` (`vite.config.ts`), así que nombres de clase
iguales entre módulos colisionan (documentado en `WhatsappInboxPage.module.css:47`).
Por eso: **un solo `ClientContextPanel.module.css` compartido** por el container y
TODOS los presentacionales de la sección, con **prefijo por sección** en cada clase:
`id-` (identidad), `fin-` (financiero), `svc-` (servicio), `int-` (interacciones),
`cand-` (picker), `sk-` (skeleton), `st-` (estados). Evita colisión sin fabricar
N módulos. Los section-components importan ese mismo módulo.

**Ubicación de archivos (FE):**
- `src/pages/whatsapp/WhatsappInboxPage/components/ClientContextPanel.tsx` — reescritura (container).
- `.../components/ClientContextPanel.module.css` — reescritura (panel + secciones, con prefijos).
- `.../components/clientContext/` (subcarpeta nueva): `MatchedClientView.tsx`, `IdentityHeader.tsx`,
  `FinancialSection.tsx`, `ServiceSection.tsx`, `InteractionsSection.tsx`, `CandidatePicker.tsx`,
  `ContextSkeleton.tsx`, `ContextNeutral.tsx`, `ContextError.tsx`.
- `src/hooks/useWhatsapp.ts` — +`useInboxClientContext` (mismo archivo, convención del repo).
- `src/api/whatsapp.api.ts` — +`getInboxClientContext`.
- `src/types/whatsapp.ts` — +los DTO FE (espejo del `InboxClientContextDto` real del BE, §2).

---

## 2. Contrato de datos FE (`types/whatsapp.ts`, espejo del DTO real del BE)

Espejo campo-a-campo del `InboxClientContextDto` del BE (`application/dto/messaging.ts`),
**verificado contra el código real, NO contra el boceto** — igual que la regla que ya
sigue `types/whatsapp.ts:1-10`. Cuando el spec del BE congele nombres/límites, este
tipo se alinea. Bosquejo a espejar:

```ts
export interface WhatsappInboxClientContext {
  status: 'matched' | 'ambiguous' | 'unknown';
  candidates?: WhatsappClientContextClient[];   // solo ambiguous sin elección
  client?: WhatsappInboxClientSummary;          // matched o candidato elegido
}

export interface WhatsappInboxClientSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'late' | 'blocked' | 'inactive' | 'baja';  // CustomerStatus
  fichaClientId: string;
  balance: {
    due: number | null;
    currency: string | null;
    isDebtor: boolean;
    stale: boolean;
    lastRefreshedAt: string | null;
  };
  lastInvoice: WhatsappInboxInvoice | null;
  nextDueDate: string | null;
  contracts: WhatsappInboxContract[];
  openTicketsCount: number;
  recentTickets: WhatsappInboxTicket[];
  recentTasks: WhatsappInboxTask[];
  recentLogs: WhatsappInboxLog[];
}
// + WhatsappInboxContract { id, plan, status, technology, address, serviceStatus }
// + WhatsappInboxInvoice { id, number, dueDate, amount, status, balance }
// + WhatsappInboxTicket  { id, sequenceNumber, subject, status, priority }
// + WhatsappInboxTask    { id, sequenceNumber, title, status }
// + WhatsappInboxLog     { id, timestamp, eventType, description }
```

`WhatsappClientContextClient` (`{id,name,status}`) ya existe y se reusa para
`candidates` y para el `CandidatePicker` — el picker sólo necesita nombre+status,
que YA vienen en el `lightContext` del detalle (instant, sin esperar el fetch rico).

---

## 3. Hook `useInboxClientContext` (TanStack) — SWR de la deuda

Molde: los 4 hooks existentes en `useWhatsapp.ts` (queryKey factory, `useDocumentVisible`
para gatear polling, `enabled`). La **deuda es stale-while-revalidate** (decisión
confirmada): el número aparece **instantáneo** desde el mirror y, si viene `stale`,
se refresca solo en background. `isFetching` de TanStack maneja el micro-estado
"actualizando…".

### 3.1 Query primaria (fast, mirror)

```ts
export const whatsappClientContextKey = (conversationId: string, clientId: string | null) =>
  ['whatsapp', 'clientContext', conversationId, clientId ?? '_'] as const;

export function useInboxClientContext(conversationId: string | null, clientId: string | null) {
  const enabled = !!conversationId;   // el container además sólo lo monta en matched/elegido
  return useQuery({
    queryKey: whatsappClientContextKey(conversationId ?? '', clientId),
    queryFn: () => api.getInboxClientContext(conversationId!, clientId ?? undefined),
    enabled,
    staleTime: 60_000,            // reabrir la misma conversación no re-dispara al toque
    refetchInterval: false,       // NO es hot loop — el panel no pollea (a diferencia de messages)
    // sin refetchOnWindowFocus agresivo: el dato del cliente cambia lento
  });
}
```

El primer response ya trae `balance.due` (mirror) + `balance.stale`. El panel
pinta el número al instante. **No hay 6 spinners** — el BE hace el fan-out
(`Promise.all`, `proposal.md` Decisión 4).

### 3.2 SWR de la deuda — patrón de 2 fases (recomendado)

La decisión de deuda confirmada dice "instantáneo del mirror + refresh en background".
HTTP no streamea, así que el patrón FE limpio es **una 2da query, background,
gateada por `balance.stale`**, que pide al BE el refresh vivo de Gestión Real
(`proposal.md` Decisión 2/A) y **parchea sólo `balance`** en el cache de la primaria:

```ts
// dentro del container, después de la primaria:
const staleBalance = data?.client?.balance.stale === true;
const balanceQuery = useQuery({
  queryKey: [...whatsappClientContextKey(conversationId, clientId), 'balanceRefresh'],
  queryFn: () => api.getInboxClientContext(conversationId!, clientId ?? undefined, { refreshBalance: true }),
  enabled: enabled && staleBalance,     // sólo si el mirror vino stale
  staleTime: 60_000,
  onSuccess: (fresh) => {
    // parchea SOLO balance en la primaria → el número transiciona in-place (§8.4)
    qc.setQueryData(primaryKey, (old) => old && fresh?.client
      ? { ...old, client: { ...old.client, balance: fresh.client.balance } } : old);
  },
});
const isRefreshingBalance = balanceQuery.isFetching;   // → pill "actualizando…" (§8.4)
```

- `balanceQuery.isFetching` alimenta el badge sutil **"actualizando…"** y la
  transición suave del número cuando llega el fresco.
- Aísla el `await` de ~4s de GR (`GetClientDetail` con refresh) a una query de
  fondo que **nunca bloquea el primer paint** ni el resto de las secciones.

**Dependencia BE (Decisión abierta A del proposal).** Este patrón asume que el
endpoint acepta el modo mirror-fast (default) y un `?refreshBalance=1` que awaitea
GR. **Fallback si el BE resuelve "siempre refresca inline"**: se cae UNA query;
"actualizando…" mapea al `isFetching` de la primaria en su refetch, y el número
igual usa `tabular-nums` + crossfade. El diseño funciona con las dos variantes;
se recomienda la de 2 fases porque es la única que da el número **instantáneo**
que pide la decisión.

### 3.3 API client (`whatsapp.api.ts`)

```ts
export const getInboxClientContext = (
  conversationId: string,
  clientId?: string,
  opts?: { refreshBalance?: boolean },
): Promise<WhatsappInboxClientContext> => {
  const params: Record<string, string> = {};
  if (clientId) params['clientId'] = clientId;             // desambiguación (Decisión 3)
  if (opts?.refreshBalance) params['refreshBalance'] = '1';
  return axiosClient
    .get<WhatsappInboxClientContext>(`${BASE}/conversations/${conversationId}/client-context`, { params })
    .then(r => r.data);
};
```

Errores: reusa el patrón del módulo (interceptor global sólo cubre 401; el resto
va a `isError`). Un 404/5xx del endpoint → estado error del panel (§4) con retry.

---

## 4. Estados del panel (matriz completa)

| Estado | Disparador | Render | Motion |
|---|---|---|---|
| **ausente** | `lightContext == null` (detalle aún sin cargar) | `<ContextNeutral>` "Sin información de contexto." | entrada suave §8.1 |
| **unknown** | `lightContext.status==='unknown'` | `<ContextNeutral>` "Contacto desconocido — sin cliente asociado." | idem |
| **ambiguous (sin elección)** | `status==='ambiguous'` && `!chosenId` | `<CandidatePicker>` — lista de candidatos (nombre + StatusBadge + "Elegir"). **No** se pide el rico todavía (respeta CTX-1, no filtra datos de varios). | stagger corto de filas |
| **loading (rico)** | `matched` \|\| (`ambiguous`+`chosenId`), `query.isLoading` | `<ContextSkeleton>` — mismo layout que el contenido, **alto reservado** (sin layout shift) | shimmer (existe) |
| **matched / elegido** | hay `data.client` | `<MatchedClientView>` — Identidad + Financiero + Servicio + Interacciones | stagger de secciones §8.2 |
| **error (con data previa)** | `isError` && hay cache | mantiene el contenido + chip sutil "no se pudo actualizar" (patrón del composer: no romper si hay data) | fade del chip |
| **error (sin data)** | `isError` && sin cache | `<ContextError>` compacto + botón "Reintentar" (`refetch`) | fade |

`matched` con `clients` vacío / `data.client` ausente (dato malformado) → cae a
neutro sin crashear (**preserva el contrato de los tests actuales**,
`ClientContextPanel.test.tsx:77`). Los 4 tests existentes (matched/unknown/ambiguous/ausente)
siguen valiendo; el rediseño los EXTIENDE, no los rompe (el link sigue siendo
`/admin/customers/view/:id`).

---

## 5. Diseño por sección (jerarquía, contenido, empty)

Layout general: **stack vertical** dentro de `.panel` (320px de columna → ~288px
de contenido con `padding: var(--space-4)`), scroll interno (`overflow-y:auto`,
ya lo tiene). Jerarquía por **peso + tamaño + color**, no por tamaño solo
(apple-design §15).

### 5.0 Decisión: STACK, no acordeón

**Recomendado: stack con `take N` + links, SIN acordeón.** Tradeoff evaluado:

| Opción | A favor | En contra | Veredicto |
|---|---|---|---|
| **Stack + límites N + links** | lo accionable (deuda, corte, tickets abiertos) SIEMPRE visible; cero interacción para leer lo importante (apple "lo más importante = lo más obvio"); crisp; sin animar `height` (evita el finding de perf de Emil "solo transform/opacity") | panel puede quedar algo largo → scroll interno | **ELEGIDO** |
| Acordeón | panel corto | esconde info accionable tras un click; animar `height` no es GPU (Emil perf) | rechazado MVP |

Los límites del DTO (`proposal.md` Decisión D: 3 tickets, 3 tareas, 5 logs, 1
factura) ya mantienen el panel corto. Para el resto: **link "Ver todos →"** a la
ficha. Acordeón queda como v2 si en uso real el panel se siente largo.

### 5.1 IdentityHeader (compacto, arriba)
- Avatar inicial (reusa `.avatar` existente, `--color-crm-purple`) + **nombre**
  (`--font-weight-semibold`, `--font-size-md`, ellipsis) + **`<StatusBadge status={client.status}/>`**
  (atom existente `components/atoms/StatusBadge` — mapea 1:1 `active|late|blocked|inactive|baja`).
- Debajo: teléfono (tel:) y email (mailto:) en filas tipo `ContactRow` (patrón
  `CustomerCard.tsx:13`), muted.
- Link **"Ver ficha completa →"** a `/admin/customers/view/${fichaClientId}`.
- Empty: si falta email/teléfono → "Sin dato" muted (patrón CustomerCard).

### 5.2 FinancialSection — **HERO (lo más prominente)**
La deuda es LO primero que el agente busca. Jerarquía #1.
- **¿Debe plata?** (`balance.isDebtor === true`):
  - Badge **"Debe"** rojo + **monto grande** (`--font-size-2xl`/`xl`,
    `--font-weight-bold`, color `var(--badge-late-fg)` = #991b1b, **tabular-nums**).
    Se usa `--badge-late-fg` y NO `--color-danger` #dc3545 como texto: #dc3545 sobre
    blanco da ~3.9:1 (falla 4.5:1 en texto normal); #991b1b da ~7.4:1 (pasa a
    cualquier tamaño). Rojo #dc3545 queda para el **fill** del badge/acento, no
    para texto chico.
  - Chip de contexto: `lastRefreshedAt` ("actualizado hace …") + pill
    "actualizando…" cuando `isRefreshingBalance` (§8.4).
- **¿Al día?** (`isDebtor === false` && `due != null`):
  - Badge **verde "Al día"** + `$0` (o el saldo). Requiere un par de tokens verde
    accesibles (ver §7.1: `--badge-paid-bg/#dcfce7` + `--badge-paid-fg/#166534`,
    ~7:1) — el repo hoy NO tiene verde-badge (BillingTab reusa el azul "active"),
    pero la decisión pide verde explícito para al-día. Adición tokenizada, no hex suelto.
- **Balance desconocido** (`due == null`): "—" muted + "Saldo no disponible". **No**
  se pinta verde (no afirmar "al día" si no se sabe).
- **Última factura** (`lastInvoice`): número + `<StatusBadge>` (mapa de BillingTab:
  `pagada→active`, `pendiente→inactive`, `vencida→late`) + importe (`Intl.NumberFormat`).
- **Próximo vencimiento** (`nextDueDate`): `formatDateShort` (util existente
  `@/utils/formatDate`). Empty → "Sin vencimientos".

### 5.3 ServiceSection — ¿qué plan? ¿está cortado?
Por cada `contract` (típico 1–2), una fila compacta:
- **Plan** (`--font-weight-medium`) + tecnología (muted, `--font-size-xs`).
- **Dirección** (`address`) muted, ellipsis (única "ubicación" disponible; "nodo"
  fuera de MVP, `proposal.md`).
- **serviceStatus** (corte PPPoE, CHEAP) como pill. Mapa a StatusBadge:
  `active→active "Activo"`, `reduced→blocked "Reducido"`, `blocked→blocked "Cortado"`,
  `baja→baja "Baja"`, `inactive→inactive "Inactivo"`, `null→` sin pill.
  (`reduced` no tiene variante propia → reusa el naranja `blocked` con label distinto,
  patrón ya usado en el repo — StatusBadge acepta `label` override.)
- Empty: "Sin contratos activos" muted.

### 5.4 InteractionsSection — tickets / tareas / logs
- **Tickets abiertos**: chip con `openTicketsCount` prominente (naranja si >0) +
  hasta 3 `recentTickets` (`#seq` + subject ellipsis + StatusBadge). Link "Ver todos →".
- **Tareas / OS**: hasta 3 `recentTasks` (`#seq` + título). Link a la ficha (tab tareas).
- **Bitácora**: hasta 5 `recentLogs` (timestamp `formatDateShort` + eventType + descripción,
  muted, `--font-size-xs`).
- Empty por sub-bloque: "Sin tickets abiertos" / "Sin actividad reciente" (empty
  POSITIVO, no cara triste; apple "delight = calma").
- Links de sección: base `/admin/customers/view/:id`. Deep-link por tab (p.ej.
  `?tab=billing`) **a verificar** si la ficha soporta query de tab; si no, base y listo
  (no inventar rutas).

---

## 6. Formato de datos (reuso verbatim)
- **Moneda**: `new Intl.NumberFormat('es-AR', { style:'currency', currency: balance.currency ?? 'ARS' })`
  → "$ 1.234,56" (idéntico a `BillingTab.tsx:9`). Un helper `formatMoney` local.
- **Fechas**: `formatDateShort` de `@/utils/formatDate` (ya usado en BillingTab).
- **Números que cambian** (deuda): `font-variant-numeric: tabular-nums` para que
  el ancho no salte al refrescar (animation-vocabulary: "Tabular numbers — esencial
  para tickers/contadores").

---

## 7. Design system aplicado (tokens, tipografía, contraste)

**NO Tailwind, NO hex hardcodeado.** Todo sale de `src/tokens/variables.css`.

### 7.1 Colores (tokens existentes + 1 par nuevo justificado)

| Uso | Token | Sobre | Ratio | ¿Pasa 4.5:1? |
|---|---|---|---|---|
| Texto primario | `--color-text-primary` #212529 | `--color-surface` #fff | ~15:1 | ✓ |
| Texto secundario/muted | `--color-text-secondary` #6c757d | #fff | ~4.6:1 | ✓ (justo) |
| Badge Activo | `--badge-active-fg` #1e40af | `--badge-active-bg` #dbeafe | ~6.0:1 | ✓ |
| Badge Atrasado/Debe | `--badge-late-fg` #991b1b | `--badge-late-bg` #fee2e2 | ~6.5:1 | ✓ |
| Badge Cortado/Reducido | `--badge-blocked-fg` #9a3412 | `--badge-blocked-bg` #ffedd5 | ~5.9:1 | ✓ |
| Badge Baja | `--badge-baja-fg` #6b21a8 | `--badge-baja-bg` #e9d5ff | ~5.6:1 | ✓ |
| **Deuda (monto grande)** | `--badge-late-fg` #991b1b | #fff | ~7.4:1 | ✓ (evita #dc3545 que da ~3.9:1) |
| **Al día (badge verde)** | **NUEVO** `--badge-paid-fg` #166534 | **NUEVO** `--badge-paid-bg` #dcfce7 | ~7.0:1 | ✓ |
| Links | ver ⚠️ | #fff | — | ⚠️ |

**⚠️ Adiciones/ajustes de token a documentar (no hardcodear):**
1. **Verde "al día"**: agregar a `variables.css` (bloque Badge, ya existe el grupo):
   `--badge-paid-bg:#dcfce7; --badge-paid-fg:#166534;` (Tailwind green-100/green-800,
   ~7:1). El repo hoy no tiene verde-badge accesible; el `--color-success` #28a745
   sobre blanco da ~3.1:1 (sólo texto grande) → no sirve como texto de badge.
2. **Links**: el `.link` actual usa `--color-primary` #0d6efd sobre blanco (~3.9:1,
   **falla** 4.5:1 en 12px). Recomendación: color de texto de link resting =
   `--color-primary-hover` #0b5ed7 (~4.5:1), manteniendo underline-on-hover y
   focus-visible. Ajuste in-token, cero hex nuevo. (Aplica también a los links
   existentes del panel — mejora de a11y colateral.)

### 7.2 Tipografía (Inter, escala del repo)
- Nombre cliente: `--font-size-md` (16px) `--font-weight-semibold`.
- Deuda hero: `--font-size-2xl` (24px) `--font-weight-bold`, `line-height-tight`,
  `letter-spacing:-0.01em` (apple: texto grande quiere tracking negativo).
- Títulos de sección: `--font-size-xs` (12px) `--font-weight-semibold`, uppercase,
  `letter-spacing:0.05em`, `--color-text-secondary` (idéntico a `.title` actual).
- Body/labels: `--font-size-sm` (14px). Meta/logs: `--font-size-xs` (12px) muted.

### 7.3 Spacing / radius / superficie
- `padding: var(--space-4)`, `gap: var(--space-3)` entre secciones, `var(--space-2)`
  intra-sección (escala 4px existente).
- Separadores de sección: `1px solid var(--color-border)` (no sombras pesadas).
- Radius: `--radius-md` en tarjetas/filas, `--radius-full` en badges/avatar.
- Touch target ≥ 44px (`--space-11`) en el botón "Elegir" del picker y en los
  links tocables (checklist ui-ux-pro-max + A11Y del inbox).

---

## 8. Animaciones (Emil) — especificación con duración/easing/skill

Curva base: **`--wa-ease-out: cubic-bezier(0.23, 1, 0.32, 1)`** (ya en el inbox =
"Strong ease-out" de Emil). Declarada local en `.panel` (standalone-safe, misma
convención que `ConversationListItem.module.css`). **Solo `transform` + `opacity`**
(regla de perf de Emil/review-animations). Todo <300ms (UI).

| # | Animación | Trigger / frecuencia | Propiedades | Duración | Easing | Skill (regla) |
|---|---|---|---|---|---|---|
| 8.1 | **Entrada del panel** al cambiar de conversación | selección (decenas/día → "reducir") | `opacity 0→1`, `translateY(4px→0)` | **180ms** | `--wa-ease-out` | emil-design-eng §"Framework" (entra→ease-out, <300ms) + apple §Response |
| 8.2 | **Stagger** de las 4 secciones al montar el contenido rico | llega `data` (ocasional) | `opacity 0→1`, `translateY(8px→0)` | **220ms** c/u, delays **0/60/120/180ms** | `--wa-ease-out`, `forwards` | emil-design-eng §"Stagger Animations" (30–80ms entre items) |
| 8.3 | **Skeleton → contenido** (sin layout shift) | fin del loading | crossfade `opacity` + `filter: blur(2px→0)` | **180ms** | ease | emil-design-eng §"Use blur to mask imperfect transitions" |
| 8.4 | **Transición del número de deuda** al refrescar (SWR) | `balanceQuery` resuelve fresco (raro → delight OK) | crossfade `opacity` + `blur(2px→0)`, `tabular-nums` | **200ms** | ease | emil §blur-mask + animation-vocabulary (*Crossfade*, *Tabular numbers*) |
| 8.4b | Pill **"actualizando…"** | `isRefreshingBalance` true | `opacity 0→1` (fade) | **150ms** | ease | apple §Feedback (status) — sutil, sin spinner ruidoso |
| 8.5 | **Press feedback** en "Elegir" (picker) y botones | tap | `transform: scale(0.97)` en `:active` | **120ms** | `--wa-ease-out` | emil-design-eng §"Buttons must feel responsive" + apple §Response |
| 8.6 | **Hover** filas de candidato | hover (gateado) | `background-color` | **150ms** | ease | patrón `ConversationListItem` (solo bg, sin transform) |

**Implementación clave:**
- 8.1/8.2: entrada vía `@starting-style` (o fallback `data-mounted`), **keyed por
  `client.id`** para que re-dispare al cambiar de cliente. El wrapper de contenido
  usa `key={client.id}`.
- 8.2 stagger: `animation: sectionIn 220ms var(--wa-ease-out) both;` + `animation-delay`
  por `:nth-child` (0/60/120/180). Keyframe `sectionIn { from{opacity:0;transform:translateY(8px)} }`.
  El stagger es decorativo: **no bloquea** interacción mientras corre.
- 8.3: skeleton con **alto reservado exacto** por sección (min-heights que igualan
  el contenido cargado) → cero salto. El `Skeleton` compartido ya existe y respeta
  reduced-motion.
- 8.4: **NO number-ticker rodante** (demasiado show para una cifra de deuda que el
  agente lee; cohesión = "dashboard crisp"). Crossfade sutil con blur + tabular-nums.
- 8.5: gatear hover detrás de `@media (hover:hover) and (pointer:fine)` (touch no
  dispara false hover).

**`prefers-reduced-motion: reduce` (obligatorio, Emil/apple: "menos, no cero"):**
```css
@media (prefers-reduced-motion: reduce) {
  /* 8.1/8.2: solo opacity, sin translate, sin stagger (delays a 0) */
  .panel [class*="fin-"], .panel [class*="svc-"], … { animation: none; transform: none; }
  /* 8.3/8.4: crossfade de opacity queda (ayuda a comprender), se cae el blur */
  /* shimmer del skeleton ya se apaga (Skeleton.module.css) */
}
```

**Anti-findings (auto-review con review-animations):** sin `transition:all`, sin
`scale(0)` (arranco en `translateY`/opacity), sin `ease-in`, sin animar
`height/width/margin`, sin keyframes en algo de alta frecuencia, todo <300ms,
reduced-motion cubierto, hover gateado. Timing asimétrico donde aplica (press
120ms in / la vuelta snap).

---

## 9. Responsive (grid actual, breakpoints 1200/860)

El panel es `.contextCol` del grid de `WhatsappInboxPage.module.css`
(`340px minmax(0,1fr) 320px`). **Cero cambios al grid** — el rediseño vive DENTRO
de la columna de 320px.

| Viewport | Comportamiento actual del grid | Panel de contexto |
|---|---|---|
| **>1200px** | 3 columnas | **visible**, 320px. El diseño de §5 está pensado para ~288px de contenido (ellipsis en nombre/dirección/subject). |
| **860–1200px** | 2 columnas, `.contextCol { display:none }` | **oculto** (comportamiento actual). No hace falta fallback link-only: el thread manda; el agente abre la ficha desde el thread si necesita. |
| **≤860px** | 1 columna, toggle por `data-has-selection` | Ver ⚠️ abajo. |

**⚠️ Constraint conocido a ≤860px.** Hoy, con selección, el grid muestra `threadCol`
Y `contextCol` en la única columna (`display:none` sólo aplica a los sin-selección),
así que a mobile el panel de contexto **se apilaría debajo del thread**. Con el
panel rico (más alto) eso empeora la experiencia mobile. **Recomendación MVP**:
ocultar el panel de contexto también a ≤860px (agregar `.contextCol{display:none}`
dentro del `@media (max-width:860px)`), y diferir un **"client info" como bottom-sheet
accionable desde el header del thread** a un follow-up (Grupo D / v2). Se documenta
como decisión, no se sobre-ingeniería ahora. (Esto es un ajuste de 1 línea al CSS
existente, aislado al breakpoint mobile.)

---

## 10. Accesibilidad (checklist ui-ux-pro-max + inbox)
- Contraste **4.5:1** en todo texto (tabla §7.1; los 2 ajustes de token cubren los
  únicos que fallaban).
- **Focus visible** en links y botones (`outline: 2px solid var(--color-primary);
  outline-offset:2px`, ya en `.link`).
- Touch target **≥44px** en el botón "Elegir" y links tocables.
- `<section aria-labelledby>` por bloque + heading; el panel raíz mantiene
  `aria-labelledby="wa-context-heading"`.
- Estado de carga: `aria-busy="true"` en el panel mientras `isLoading` (el
  `Skeleton` es `role="presentation"`, no anuncia; el "cargando" lo comunica el
  contenedor).
- Íconos: SVG (Heroicons/Lucide), **no emojis** (checklist ui-ux-pro-max). Si no
  hay set de íconos en el repo, texto/badges primero (el repo hoy es text-first).
- `cursor:pointer` en clickables.
- Números de deuda con `tabular-nums` (no salta el layout, ayuda a lectura).

---

## 11. Riesgos y dependencias del BE (afectan al FE)

- **Decisión abierta A (balance con/sin refresh)** → define si el hook usa el
  patrón de 2 fases (§3.2, recomendado, da número instantáneo) o 1 query. El
  diseño soporta ambas; se prefiere 2 fases.
- **Decisión abierta B (RBAC)** → si el endpoint exige permisos extra (billing/tickets),
  el FE debe manejar un **403 por sección** con degradación elegante (mostrar lo
  permitido, ocultar/deshabilitar lo denegado con un "sin permiso" muted) en vez de
  romper el panel entero. A confirmar con el spec.
- **Decisión abierta D (límites N)** → el diseño ya asume 3/3/5/1; si cambian, sólo
  cambian los `.slice`/labels, no la estructura.
- **Drift de contrato**: `types/whatsapp.ts` espeja el DTO **real** del BE, no el
  boceto. Si el BE renombra (`fichaClientId`, `serviceStatus`), alinear el tipo FE
  (mismo protocolo que ya siguió F1).
- **Latencia GR (≤4s)**: aislada a la query de fondo (§3.2) — nunca bloquea el
  primer paint; si falla, el número queda en el valor mirror + chip "no se pudo
  actualizar" (no rompe).

---

## 12. Archivos afectados (FE) — resumen para `sdd-tasks`

| Archivo | Cambio |
|---|---|
| `src/pages/whatsapp/WhatsappInboxPage/components/ClientContextPanel.tsx` | reescritura → container fino (hook + estado + switch) |
| `src/pages/whatsapp/WhatsappInboxPage/components/ClientContextPanel.module.css` | reescritura (panel + secciones, clases con prefijo) |
| `src/pages/whatsapp/WhatsappInboxPage/components/clientContext/*` | **nuevos** presentacionales (MatchedClientView, IdentityHeader, FinancialSection, ServiceSection, InteractionsSection, CandidatePicker, ContextSkeleton, ContextNeutral, ContextError) |
| `src/pages/whatsapp/WhatsappInboxPage.tsx` | pasar `conversationId` + `lightContext` al panel (2 props) |
| `src/hooks/useWhatsapp.ts` | +`useInboxClientContext` (+ query de balanceRefresh) |
| `src/api/whatsapp.api.ts` | +`getInboxClientContext` |
| `src/types/whatsapp.ts` | +DTO FE (`WhatsappInboxClientContext` y sub-tipos) |
| `src/tokens/variables.css` | +`--badge-paid-bg/-fg` (verde al-día); link color a `--color-primary-hover` |

**Testing (strict TDD, patrón del repo):** RTL sobre cada presentacional (estados
matched/ambiguous/unknown/loading/error/empty), test del container mockeando
`useInboxClientContext`, y test de contraste/badge como los existentes
(`MessageBubble.contrast.test.tsx`). Los 4 tests actuales de `ClientContextPanel`
se mantienen verdes (contrato preservado).
