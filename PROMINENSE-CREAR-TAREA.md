# Prominense — Crear tarea de visita técnica (VISITA TECNICA - FIBRA)

## Credenciales de login

```
Usuario: superadmin
Password: zaJvvg7RS4yTJS0athfq
```

(fuente: `/home/ronald/los-notify/.env` en saturno)

## Paso a paso

### 1. Login (guarda cookie de sesión)

```bash
curl -c /tmp/prom_cookies.txt -X POST https://app.prometheus-alpha.xyz/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"superadmin","password":"zaJvvg7RS4yTJS0athfq"}'
```

Respuesta esperada (200):
```json
{"user":{"id":"...","username":"superadmin","email":"superadmin@ipnext.local"}}
```

La cookie queda guardada en `/tmp/prom_cookies.txt` y sirve para todas las llamadas siguientes.

### 2. Conseguir customerId y contractId del cliente

Vía SSH a saturno, contra la réplica de la DB de Prominense:

```bash
ssh -p 2222 ronald@190.7.234.37 "docker exec bd_owners_splynx-repli.1.7l19c20efrc8760oo8zn2wawk psql -U test -d test -t -c \"
select c.id, c.name, c.phone from \\\"Client\\\" c where c.name ilike '%NOMBRE DEL CLIENTE%';
\""
```

```bash
ssh -p 2222 ronald@190.7.234.37 "docker exec bd_owners_splynx-repli.1.7l19c20efrc8760oo8zn2wawk psql -U test -d test -t -c \"
select ct.id, ct.status, ct.technology from \\\"Contract\\\" ct where ct.\\\"clientId\\\" = '<customerId>';
\""
```

Si el cliente tiene más de un contrato, cruzar con `ScheduledTask` (tareas previas) para identificar cuál es el contrato de fibra afectado.

### 3. Armar el JSON de la tarea (SIEMPRE en un archivo, nunca inline)

Los acentos/tildes en un `-d '...'` inline rompen el POST (HTTP 400 silencioso). Escribir a un archivo y usar `--data-binary @archivo.json`.

```bash
cat > ./tarea.json << 'EOF'
{
  "kind": "customer",
  "title": "Visita tecnica - LOS fibra - NOMBRE DEL CLIENTE",
  "priority": "high",
  "estimatedHours": 1,
  "category": "visita",
  "customerId": "<uuid del cliente>",
  "contractId": "<uuid del contrato de fibra>",
  "projectId": "9ffa5d40-03ab-48ed-be44-1a10622297bb",
  "description": "Detalle del diagnostico tecnico (ONU, puerto, senal, causa)"
}
EOF
```

Campos obligatorios:
- `kind`: siempre `"customer"`
- `title`, `priority`, `estimatedHours`, `category`
- `customerId`, `contractId`
- `projectId`: fijo, es el proyecto "VISITA TECNICA - FIBRA" → `9ffa5d40-03ab-48ed-be44-1a10622297bb`
- `description`

### 4. POST para crear la tarea

```bash
curl -b /tmp/prom_cookies.txt -X POST https://app.prometheus-alpha.xyz/api/scheduling \
  -H 'Content-Type: application/json' \
  --data-binary @./tarea.json
```

Respuesta (201) trae el `id` y `sequenceNumber` de la tarea creada (ej. `#6410`).

### 5. (Opcional) Actualizar fecha de la visita

Si Ronald indica una fecha concreta (ej. "mañana"):

```bash
cat > ./update.json << 'EOF'
{"startDate": "2026-09-16T12:00:00.000Z"}
EOF

curl -b /tmp/prom_cookies.txt -X PUT https://app.prometheus-alpha.xyz/api/scheduling/<id-de-la-tarea> \
  -H 'Content-Type: application/json' \
  --data-binary @./update.json
```

## Gotchas

- **Cookie expirada**: si el POST devuelve `401 {"error":"Authentication required","code":"UNAUTHORIZED"}`, repetir el paso 1 (re-login) y reintentar.
- **Acentos en curl inline**: nunca usar `-d '{"content":"...á..."}'` directo — usar archivo + `--data-binary @archivo.json`.
- **Múltiples contratos por cliente**: verificar cuál corresponde al servicio de fibra afectado (cruzar con `ScheduledTask` anteriores o con la dirección/ONU reportada).
