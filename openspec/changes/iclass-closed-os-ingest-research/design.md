<!-- generated from engram topic_key: sdd/iclass-closed-os-ingest-research/explore -->
**What**: Live research against IClass FS v2 API (https://api-v2.iclass.com.br, cluster `IPNEXT INTERNET`, user `IPNXAPI`) to understand closed Service Order lifecycle and the data captured at closure.

**Why**: Scoping a future ipnext-backend integration that mirrors closed OSs (technician work product) into our DB. Need to know which endpoints to poll, which fields are populated, and what the minimum useful payload is.

**Where**: Read-only research — no code touched. Spec downloaded to `./iclass-openapi.json` and `./so-*.json` snapshots for inspection (worktree).

---

### 1) OS lifecycle and CLOSED states

`status` on the SO list/detail is `{id:int, descricao:string}` (schema `StatusDTO1`). On the **history sub-resource** the status appears as `{codigo:string, descricao:string}` (schema `SOStatusDTO`) — and `codigo` is the SAME ID just as string. Confirmed by `data` matching across both shapes.

Status codes observed in real IPNEXT data (`/serviceorders/{id}/history`, last 1 month):

| codigo | descricao (PT-BR, real)        | Semantic                              |
|--------|--------------------------------|---------------------------------------|
| 1      | ABERTA                         | Created                               |
| 49     | PRÉ ABERTA                     | Pre-open                              |
| 17     | DESPACHADA EMPREITEIRA         | Dispatched to contractor              |
| 29     | AGENDADA                       | Scheduled                             |
| 12     | ASSOCIADA EQUIPE               | Assigned to team                      |
| 10     | DESPACHADA                     | Dispatched to team                    |
| 18     | EM ANALISE                     | Under analysis                        |
| 2      | DESLOCAMENTO                   | Team in transit                       |
| 3      | ANDAMENTO                      | Work in progress                      |
| 4      | FECHADA                        | Closed by technician (pending approval) |
| 50     | APROVAÇÃO                      | Under approval                        |
| **7**  | **ENCERRADO** (detail says **Concluida**) | **FINAL — done, approved**       |
| (8)    | Cancelada                      | NOT observed in IPNEXT cluster (skill doc mentions but no live samples) |

Key insight: **status id=7 is the only terminal/closed state actually present** in IPNEXT data. The list `GET /serviceorders` for IPNEXT INTERNET cluster across May 2026 (239 results) returned 100% `status.id=7 / Concluida`. Probing `statuses=1..12` returned empty except 7 — meaning the cluster effectively only stores `Concluida` SOs (the others may be filtered out, archived elsewhere, or simply absent in this tenant).

The status localization is mixed: detail endpoint says **"Concluida"** (Spanish), history endpoint says **"ENCERRADO"** (Portuguese). Same `id=7`. Don't compare by descricao — compare by id/codigo.

`status.id=4 (FECHADA)` is the **technician-closed** intermediate state; `id=50 (APROVAÇÃO)` is "awaiting back-office approval"; `id=7 (ENCERRADO/Concluida)` is the truly final state once approved. This is the closure pipeline.

---

### 2) Fields populated at closure (ServiceOrderDTO2 detail)

From `/serviceorders/{id}` on real closed OSes. The detail schema (`ServiceOrderDTO2`) has ~40 fields. Populated at closure:

- `motivoFechamento` — **the close reason / result-code name** (e.g. "Instalacion Completa Wireless", "Verificacion Red Fibra Optica Completada"). This maps to `SOTypeResultCodesDTO.codigo` of the SO type.
- `fechadoPor: {login, nome}` — technician/user who closed.
- `alteradoPor: {nome, login, data}` — last modifier (often the approver).
- `criadoPor: {nome, login, data}` — creator.
- `equipe: {login, tecnico, fone1, tipoEquipe, email, status, ativo}` — assigned crew (technician name/phone/email).
- `comentario` — free-text comments (timestamped, multi-author, e.g. `[IPNXLUISS - 03/05/2026 22:28:15 America/Buenos_Aires]: ticket duplicado`).
- `obs` — initial observation set on creation.
- `obsEquipe` — technician's closing note (e.g. "ok").
- `informacoesSigilosas` — sensitive info field (rarely populated).
- `coordenadasFechamento: {dataRegistro, latitude, longitude}` — **GPS at close**. Frequently EMPTY `{}` even on closed OSes (the technician may not have shared GPS).
- `valorCobranca` (double) — billing amount.
- `dataAgendamento`, `dataSolicitacao`, `dataDisponibilidade` — scheduling timestamps.
- `dataInicioAtendimento`, `dataFimAtendimento`, `dataIniDeslocamento`, `dataFimDeslocamento`, `dataMaxAtendimento`, `dataSla` — listed in schema but often `undefined` in real responses (Quarkus likely omits null fields).
- `revisita: boolean`, `priorizada: boolean`, `setor`, `responsavel`, `parentesco`, `numProjeto` — metadata.
- `tipoOs: {id, descricao, resumoTipoOs}` — service order type.
- `contrato: {id, codigo, nomeTitular, ...}` — customer/contract.
- `node: {codigo, descricao}` — network node.
- `endereco: {id, codigo, logradouro, cidade, pais, latitude, longitude}` — service address.

The **remaining 9 fields are HATEOAS string links**, not data:
- `historicoStatus: "/serviceorders/{id}/history"`
- `procedimentos: "/serviceorders/{id}/procedures"`
- `pesquisas: "/serviceorders/{id}/checklist"`
- `materiais: "/serviceorders/{id}/materials"`
- `ativos: "/serviceorders/{id}/equipments"`
- `historicoAtivos: "/serviceorders/{id}/equipments/history"`
- `despesas: "/serviceorders/{id}/expenses"`
- `ativosEndereco: "/serviceorders/{id}/adresses/equipments"` (sic, typo)
- `ambientes: "/serviceorders/{id}/environments"`

You **must drill into each** to get the actual closure data. Empty subresources return HTTP 204.

#### Checklist (`/serviceorders/{id}/checklist`) — the rich one

For SO 101040440756 (real install) the checklist exposes 7 questions covering materials used, GPS coords (free text), photos, and notes:

```json
{
  "pesquisaId": 243692190673731070,
  "dataPesquisa": "2026-05-08T16:31:10.000+00:00",
  "perguntas": [
    {"pergunta":"DESCRIBA DETALLADAMENTE LOS MATERIALES UTILIZADOS","resposta":{"resposta":"utp 30\nrj 2\n","tipoPergunta":"Texto"}},
    {"pergunta":"INGRESE LAS COORDENADAS EXACTAS","resposta":{"resposta":".","tipoPergunta":"Texto"}},
    {"pergunta":"SAQUE FOTO DE LA MAC Y SN DE LA ANTENA","resposta":{"ordem":2,"tipoPergunta":"Foto"}},
    {"pergunta":"SAQUE FOTO DE LA MAC Y SN DEL ROUTER","resposta":{"ordem":3,"tipoPergunta":"Foto"}},
    {"pergunta":"SAQUE FOTO DE LA SEÑAL DEL SERVICIO","resposta":{"ordem":4,"tipoPergunta":"Foto"}},
    {"pergunta":"SAQUE FOTO DE LA PRUEBA DE VELOCIDAD","resposta":{"ordem":5,"tipoPergunta":"Foto"}},
    {"pergunta":"DESCRIBA SI QUEDO PENDIENTE","resposta":{"resposta":"n","tipoPergunta":"Texto"}}
  ]
}
```

CRITICAL GOTCHA: **Photo answers have NO URL/binary in the API response.** They surface `tipoPergunta:"Foto"` and `ordem` but **the actual photo file is not exposed via v2**. Probed `/photos`, `/files`, `/attachments`, `/medias`, `/fotos`, `/anexos`, `/midia`, `/signatures` on `/serviceorders/{id}` — all return 500 (route does not exist). The v2 API is **photo-blind**. Photos exist only inside IClass's app/portal. Same for signatures — `SOTypeResultCodesDTO.obrigatoriedadeAssinatura` flags whether one is required, but no signature payload is returned.

#### History (`/serviceorders/{id}/history`)
Paginator of `SOHistoryDTO`. Each entry = `{osStatusId, data, statusOS:{codigo,descricao}, equipeDTO?, comentario?, tempoStatus}` where `tempoStatus` is time spent in that status (minutes). Includes the full timeline from `ABERTA` to `ENCERRADO`. Always populated on closed SOs.

#### Materials / Equipments / Procedures / Expenses / Environments
Mostly **204 No Content** even on closed SOs. Schemas exist (`SOMaterialDTO`, `SOEquipmentDTO`, etc.) but in real IPNEXT data these are not consistently populated — most installation/materials info ends up inside the checklist `Texto` answers as free text. This is a major data-quality gotcha: don't assume `/materials` will have the materials list.

#### Result codes (`/serviceordertypes/{id}/resultcodes`)
Per SO-type configured catalog. Example: SOType `37092709` (Red Fibra) has 1 result code "Verificacion Red Fibra Optica Completada" with `tipo:"Sucesso"`, signature not required. The `motivoFechamento` on the closed SO equals the `codigo` of the picked result code.

---

### 3) Endpoints to retrieve a closed OS with all info

Closure ingest = 3-step fan-out per SO:
1. `GET /serviceorders` (cluster + date range, paginated) → list.
2. `GET /serviceorders/{id}` → full `ServiceOrderDTO2` detail.
3. Fan out to sub-resources (each may be 204):
   - `/serviceorders/{id}/history` — almost always populated.
   - `/serviceorders/{id}/checklist` — populated when SO type has a survey model; richest closure data.
   - `/serviceorders/{id}/materials` — usually empty.
   - `/serviceorders/{id}/equipments` and `/equipments/history` — usually empty.
   - `/serviceorders/{id}/procedures` — usually empty.
   - `/serviceorders/{id}/expenses` — usually empty.
   - `/serviceorders/{id}/environments` — usually empty.
   - `/serviceorders/{id}/adresses/equipments` (typo intentional).

Auxiliary catalogs (cache locally, rarely change):
- `GET /serviceordertypes?description=...` and `/serviceordertypes/{id}/resultcodes` — to interpret `motivoFechamento`.
- `GET /clusters`, `/nodes`, `/teams/{id}` — for FK enrichment.

---

### 4) Restrictions / gotchas

- **`clusterName` is REQUIRED** on `GET /serviceorders`. The only IPNEXT cluster is `IPNEXT INTERNET`.
- **One of `createdDate_*` or `updatedDate_*` is REQUIRED**. Without it → `400 "Um limite de datas deve ser especificado"`.
- **Date format is `dd-MM-yyyy HH:mm`** — NOT ISO. The OpenAPI examples confirm. Other formats → 400.
- **Max window = 30 days**. Larger → `400 "A quantidade de dias não pode ser maior do que 30"`.
- **Pagination**: standard `pagenumber/pagesize`. Cap appears to be 60. `totalpages`/`hasMoreElements` on response.
- **Status `7`** is the terminal state — for ingest, query `updatedDate_begin/_end` filters to catch newly-closed/re-modified SOs (since approval flips status from 4→50→7 days later).
- **Rate limiting**: hitting sub-resources back-to-back returns `"Espere um pouco antes de fazer outra requisição"` (HTTP 200 with that text body). No documented rate-limit headers. Need backoff between requests.
- **No webhooks**: `grep` of all 88 paths for `webhook|hook|subscrib|notif|event` returns nothing. **Polling is the only option.**
- **Photos and signatures are NOT exposed via v2**.
- **204 No Content** is the standard response for empty list resources — not 200 with `{objects:[]}`. Treat 204 as "empty subresource".
- **Localization is inconsistent**: same status `id=7` shows as "Concluida" on detail and "ENCERRADO" on history. Schema field names mostly PT (`codigo`, `descricao`, `dataAgendamento`, `coordenadasFechamento`). Don't switch on text.
- **Typo `/adresses/equipments` is real** — respect as-is.
- **`fechadoPor` is missing from real responses** despite being in the schema; closure attribution lives in `alteradoPor` (final mutation) + `motivoFechamento`.
- **HATEOAS links are returned as plain strings** in DTO fields (`procedimentos: "/serviceorders/.../procedures"`), not objects with `href`. Easy to misparse.
- Date strings in history responses use `dd-MM-yyyy HH:mm:ss`; detail uses the same; checklist `dataPesquisa` uses ISO-8601 with timezone. Mixed.

### Sample status counts (live, May 2026 IPNEXT INTERNET, createdDate 01-04 to 27-05)
- 239 SOs in 27-day window, **100% status id=7 / Concluida**. The orchestrator/portal pre-closes everything before exposing via API — or filters out non-closed for this tenant.
