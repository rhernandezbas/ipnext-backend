# Design — messaging-campaign-manual-recipients

**Change**: messaging-campaign-manual-recipients · **Phase**: design · **Project**: ipnext-backend
**Reads**: `proposal.md`, `specs/messaging-bulk/spec.md` (delta MAN-1..MAN-6).

## Decisión 1 — `manualClientIds` PARALELO al segment (no dentro)

`CampaignSegment` = `{ statuses, balanceMin?, balanceMax? }` es el FILTRO reproducible/auditable que
se serializa en `Campaign.segment` (Json). La lista manual NO es un filtro: es una inclusión explícita
de clientes puntuales. Meterla dentro de `CampaignSegment` ensuciaría la semántica del filtro serializado
(¿se audita como "criterio"?). Va como campo hermano en `CreateCampaignInput`/`PreviewSegmentInput`:
`manualClientIds?: string[]`.

## Decisión 2 — Port nuevo narrow `ManualRecipientSource` (ISP)

`domain/ports/CustomerRepository.ts` ya segrega `CampaignSegmentSource`, `CampaignRecipientLookup` y
`OptOutRegistry` como interfaces separadas (documentado ahí: no forzar a los fakes/adapters a
implementar métodos que no usan). Sigo ese precedente:

```ts
export interface ManualRecipientSource {
  /** Resuelve un batch de clientIds a candidatos. Devuelve SOLO los que existen (subset). */
  findRecipientCandidatesByIds(clientIds: string[]): Promise<CampaignRecipientCandidate[]>;
}
```

`PrismaCustomerRepository` lo implementa (misma instancia `customerAdapter` que ya sirve
`CampaignSegmentSource`): `findMany({ where: { id: { in } }, select: {... status ...} })`. Selecciona
`status` (a diferencia de `findRecipientCandidate` del re-check per-envío) para que `statusCounts` del
preview sea honesto.

**Por qué NO reusar `CampaignRecipientLookup.findRecipientCandidate` (uno por uno)**: sería N+1 en el
adapter Prisma para una lista de N clientes; el batch `IN` es una sola query.

## Decisión 3 — Helper compartido `resolveCombinedRecipients`

DRY entre `CreateCampaign` y `PreviewCampaignSegment`. Orquesta:
1. Resolver el segmento SOLO si `segmentHasCriteria(segment)` (predicado puro extraído de
   `assertSegmentIsFiltered`). Si el segmento no tiene criterio (caso "solo manual"), NO se toca la
   fuente (evita el `where:{}` = toda la base).
2. Resolver los manuales (si hay): `findRecipientCandidatesByIds` → detectar faltantes por set-diff →
   `ManualRecipientsNotFoundError` si hay → `resolveRecipients` (opt-out/dedup/teléfono).
3. Unión dedup por `clientId` (segmento primero, manual llena huecos), ordenada por `clientId`.

Devuelve `{ resolved, segmentResolved, manualResolved, segmentSkipped, statusCounts }`.

## Decisión 4 — Guard nuevo `assertHasRecipients`, `assertSegmentIsFiltered` INTACTO

```ts
export function assertHasRecipients(segment, manualClientIds: string[]): void {
  if (manualClientIds.length > 0) return;      // lista manual no vacía = target válido
  assertSegmentIsFiltered(segment);            // si no, exigí criterio de segmento
}
```

`assertSegmentIsFiltered` NO cambia su comportamiento (los tests existentes de `PreviewCampaignSegment`
y `ListSegmentRecipients` siguen verdes). Solo se refactoriza para exponer `segmentHasCriteria`
(predicado) sin cambiar el throw. `ListSegmentRecipients` sigue usando `assertSegmentIsFiltered` (no
recibe lista manual — es el "ver todos" del segmento).

## Decisión 5 — Fail-loud tipado + wire

`ManualRecipientsNotFoundError extends DomainError` con code `MANUAL_RECIPIENTS_NOT_FOUND`, campo
`missingClientIds: string[]`. `statusMap` → **422** (request bien formado pero referencia entidades
inexistentes — mismo criterio que `EMPTY_SEGMENT`/`MISSING_TEMPLATE_VARIABLES`; `UNFILTERED_SEGMENT` es
400 porque es "falta criterio", distinto). `domainErrorToCode` suma `missingClientIds`; `errorHandler`
lo proyecta al body.

## Decisión 6 (dedup) — unión por `clientId` **Y por teléfono** (revisada en FIX-1)

`resolveRecipients` dedup por `normalizePhone` DENTRO de cada set (segmento, manual). La UNIÓN se dedup
por `clientId` (protege el `@@unique[campaignId, clientId]`) **Y por teléfono normalizado** (FIX-1).

**Versión original (BUGGY)**: la unión se colapsaba SOLO por `clientId`; dos clientes con `clientId`
distinto pero MISMO teléfono (uno del segmento, uno manual) sobrevivían → **2 WhatsApp al mismo número**.
Peor: si el segmento ya había colapsado a B por teléfono (SEG-3), agregarlo a mano lo RESUCITABA.

**FIX-1 (corregido)**: la unión colapsa también por `phoneNormalized` (la MISMA clave `normalizePhone`
que usa `resolveRecipients` para su dedup interno — no se inventa otra). **Precedencia**: el segmento
entra primero (por `clientId` y por teléfono); el manual llena huecos SOLO si su `clientId` y su teléfono
no están ya en la unión. Un manual que colisiona por teléfono con un recipient del segmento se EXCLUYE
(no se materializa un 2º recipient al mismo número) y se cuenta en `manualSkipped.duplicatePhone`.

El caso "mismo cliente en ambos" (mismo `clientId`) sigue colapsando a uno (MAN-1 "manual que ya cae en
el segmento"). El manual overlap por `clientId` se filtra ANTES de resolver (no se doble-cuenta, ver
Decisión 9/FIX-2). Nota: colapsar por teléfono puede dropear un cliente elegido a mano cuando comparte
teléfono con otro ya incluido — es el comportamiento CORRECTO (evita el doble envío); el operador ve la
exclusión reflejada en `skipped.duplicatePhone` (FIX-2), no es un drop silencioso.

## Decisión 7 — orden en `CreateCampaign.execute`

1. `assertHasRecipients(segment, manualIds)` (rechaza vacío-total ANTES de efectos)
2. template approved (CAMP-2) — sin cambios
3. missing vars (CAMP-3) — sin cambios
4. `resolveCombinedRecipients(...)` — puede lanzar `ManualRecipientsNotFoundError`
5. `resolved.length === 0` → `EmptySegmentError` (CAMP-4) — sin cambios
6. persistir header + `bulkCreateRecipients(resolved)` — mapping sin cambios

## Decisión 8 — constructores con dep OPCIONAL (no-regresión literal)

`CreateCampaign` suma 4º arg `manualRecipientSource?: ManualRecipientSource`; `PreviewCampaignSegment`
suma 2º arg `manualRecipientSource?`. OPCIONALES a propósito: los tests existentes (`CreateCampaign.test.ts`,
`messagingBulk.routes.test.ts`) instancian con la aridad vieja y quedan compilando y verdes SIN tocarlos
(prueba literal de no-regresión). Si llega `manualClientIds` no vacío sin source inyectado, se lanza un
Error defensivo (nunca ocurre: `app.ts` y los tests nuevos SIEMPRE inyectan `customerAdapter`).

## Decisión 9 — preview: `skipped` **reconcilia** segmento + manual (revisada en FIX-2)

`PreviewSegmentOutput.count` es el tamaño de la unión; `statusCounts` se recomputa sobre la unión.

**Versión original (BUGGY)**: `skipped` reportaba SOLO las exclusiones del SEGMENTO. Las de la lista
manual (opt-out, teléfono inválido, y el duplicate-phone cross-set del FIX-1) NO se contaban → el
operador seleccionaba 3, el preview decía 2, `skipped` decía `{0,0,0}` → no reconciliaba, sin explicación.

**FIX-2 (corregido)**: `skipped = segmentSkipped + manualSkipped`, SIN doble-contar el overlap.

### Semántica elegida (evita el doble conteo del overlap)

Sean `S` = clientIds de TODOS los candidatos que devuelve el segmento (resueltos + excluidos) y `M` =
candidatos de la lista manual (todos existen, MAN-3 fail-loud; `M` ya viene dedup por `clientId` desde
`normalizeManualClientIds`).

- **Partición del segmento**: `resolveRecipients` garantiza `|S| = |segmentResolved| + segmentSkipped.optedOut
  + segmentSkipped.invalidPhone + segmentSkipped.duplicatePhone` (cada candidato cae en EXACTAMENTE un bucket).
- **`manualSkipped` cuenta SOLO los manuales que NO hacen overlap por `clientId` con el segmento**
  (`M \ S`). Un manual cuyo `clientId` ya es candidato del segmento ya está contabilizado allá (como
  resuelto o como excluido) — sumarlo de nuevo lo DOBLE-CONTARÍA. Por eso el helper filtra
  `manualNonOverlap = M \ S` ANTES de `resolveRecipients`, y de ahí salen `manualSkipped.{optedOut,
  invalidPhone,duplicatePhone-dentro-del-set}`; el colapso cross-set del FIX-1 se suma a
  `manualSkipped.duplicatePhone`.
- El overlap por `clientId` (mismo cliente en ambos sets) NO cuenta ni en enviables (colapsa a uno por
  `clientId`) ni en skipped (se filtró de `manualSkipped`) — cuenta una sola vez, vía el segmento.

**Invariante que se cumple**: `count + Σ skipped = |S| + |M \ S|` = destinatarios ÚNICOS considerados
(por `clientId`). Ejemplos verificados: solo-manual `['c1','c2','c3']` con c2 opt-out → `count=2`,
`skipped.optedOut=1`, `3 = 2 + 1`. Segmento A + manual B(mismo teléfono, `clientId≠A`) → `count=1`,
`skipped.duplicatePhone=1`, `2 = 1 + 1`.

**No-regresión (FIX-2 d)**: para el caso segment-only (`manualSkipped = {0,0,0}`), `skipped = segmentSkipped`
EXACTAMENTE — los preview segment-only reportan los mismos números que antes.

GET `/segment/preview` (deep-link) queda segment-only; el composer usa POST para la unión.

## Decisión 10 (FIX-3) — cota superior de `manualClientIds`

`MAX_MANUAL_RECIPIENTS = 5000` (constante nombrada en `resolveCombinedRecipients.ts`).
`resolveCombinedRecipients` rechaza con `TooManyManualRecipientsError` (code `TOO_MANY_MANUAL_RECIPIENTS`
→ **422**, misma familia que `TOO_MANY_ATTACHMENTS`) cuando la lista NORMALIZADA excede la cota, ANTES de
tocar la DB (la verificación es lo PRIMERO en el helper, antes incluso de resolver el segmento).

**Por qué 5000**: la lista manual es HAND-CURATED (el operador elige clientes puntuales en el composer);
unos pocos miles ya es un techo generoso. Un array multi-miles jamás es una curaduría legítima y
explotaría la query batch `id IN (...)` hacia el techo de ~65535 bind params de Postgres (un 500 crudo).
5000 deja headroom de sobra bajo ese límite incluso con otros params en la misma sentencia, y el envío
masivo de MILES va por el FILTRO del segmento, no por la lista manual. Se mide sobre la lista normalizada
(dedup + sin vacíos) porque es la que efectivamente pega al `findRecipientCandidatesByIds`.

## Decisión 11 (FIX-4) — `manualClientIds` fail-loud en el parser de la ruta

`toManualClientIds` (messagingBulk.routes.ts) ya NO descarta no-strings en silencio (contradecía MAN-3):
- AUSENTE (`undefined`) → `[]` (campaña solo-segmento, válido — NO se rompe).
- PRESENTE pero no-array, o array con algún elemento no-string → `InvalidManualRecipientsError`
  (code `VALIDATION_ERROR` → **400**, misma convención que `InvalidTemplateInputError`). Un id que viaje
  como number desaparecería mudo — fail-loud lo rechaza.
- Strings vacíos/whitespace → NO son error: son normalización (el use case los limpia con trim vía
  `normalizeManualClientIds`). El guard cross-set/parser distingue "id malo" (contrato) de "id a limpiar".

## Known-debt (documentadas, NO arregladas en esta ola)

- **GET `/segment/preview` ignora `manualClientIds`** (por diseño: el composer usa POST para la unión; el
  GET es un deep-link segment-only). No es un bug — queda registrado para no re-descubrirlo.
- **`manualClientIds` NO se persiste en la entidad `Campaign`**: solo se materializan los `CampaignRecipient`
  de la unión. La auditoría "quién fue inclusión MANUAL vs vino del segmento" no queda registrada.
  Follow-up posible: un flag `source: 'segment'|'manual'` por recipient, o guardar la lista manual cruda.
- **`EmptySegmentError`/label "segmento" en el caso manual-only todo-excluido**: cuando una campaña
  solo-manual resuelve a cero (todos opt-out/teléfono-inválido), el error dice "segmento" aunque no hubo
  segmento. Cosmético — el 422 es el status correcto; el mensaje podría afinarse.

## Desviaciones del plan original

- El plan mencionó "el InMemory (que el search del fake matchee phone)". NO existe un
  `InMemoryCustomerRepository` compartido: los fakes de `CustomerRepository`/`CampaignSegmentSource` son
  jest-mocks/inline por test. La cobertura real y testeable-sin-Prisma de MAN-6 es la función pura
  `buildClientListWhere` (mismo criterio que el resto de `PrismaCustomerRepository.list.segment.test.ts`).
