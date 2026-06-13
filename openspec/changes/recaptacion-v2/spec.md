# Spec: Recaptación v2 — CSV Import (BE)

## Wire Contract

```
POST /api/recapture/import-csv
  Auth: required
  Perm: recapture.manage
  Body: { csv: string }
  200:  { created: number, errors: string[] }
  400:  { error: "Missing required field: csv", code: "VALIDATION_ERROR" }
  403:  PERMISSION_DENIED

GET /api/recapture/import-csv/template
  Auth: required
  Perm: recapture.read
  200:  text/csv; Content-Disposition: attachment; filename="recaptacion-template.csv"
        Body: header row + 1 example row
  403:  PERMISSION_DENIED
```

## CSV Format

Header row (exact, order-insensitive):
```
nombre,telefono,email,direccion,motivo_baja,plan_anterior
```

- `nombre` — required; row is skipped with error entry if blank
- All other columns — optional; empty string maps to `null`
- Quoted fields (RFC 4180) supported
- CRLF and LF line endings both accepted
- Trailing blank rows silently ignored
- Partial batch: errors do not abort the import

## Data Mapping

| CSV column     | RecaptureLead field |
|----------------|---------------------|
| nombre         | contactName         |
| telefono       | phone               |
| email          | email               |
| direccion      | address             |
| motivo_baja    | churnReason         |
| plan_anterior  | previousPlan        |

All CSV leads: `source = 'csv'`, `clientId = null`.

## Domain Changes

`RecaptureLead` entity gains 3 optional fields:
- `address: string | null`
- `churnReason: string | null`
- `previousPlan: string | null`

`CreateRecaptureLeadData` gains the same 3 optional fields.

## Migration

Additive only — `20260719000000_add_recapture_csv_fields`:
```sql
ALTER TABLE "RecaptureLead"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "churnReason" TEXT,
  ADD COLUMN "previousPlan" TEXT;
```

No `BEGIN`/`COMMIT` wrapper (handled by Prisma migrate engine).

## Error Format

Each error string: `"Row {N}: missing required field \"{field}\""` where N is 1-based index into non-blank data rows.

## Scenarios

### Happy path — 2 valid rows
- POST /import-csv with 2-row CSV → `{ created: 2, errors: [] }`
- Both leads in repo with `source='csv'`, `clientId=null`

### Partial — 1 invalid + 1 valid
- Row 1 missing nombre → counted in errors
- Row 2 valid → created
- Returns `{ created: 1, errors: ["Row 1: ..."] }`

### RBAC guard
- POST without `recapture.manage` → 403
- GET template without `recapture.read` → 403

### Template endpoint
- Returns `Content-Type: text/csv`
- Contains `Content-Disposition: attachment`
- Body has exactly 6 headers: `nombre,telefono,email,direccion,motivo_baja,plan_anterior`
- Includes at least 1 example data row
