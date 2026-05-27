# Spec: Feature Flags

**Capability**: `feature-flags` (NEW)
**Change**: `task-send-to-iclass`
**Summary**: Flags persistidos en PostgreSQL, consultables y toggleables por API en runtime. Primer flag: `iclass-integration`.

---

## Added Requirements

### REQ-FF-MODEL-1: Modelo persistido

El sistema MUST persistir flags en una tabla `FeatureFlag` con: `key` (string, único, PK lógica), `enabled` (boolean), `updatedAt` (datetime). El seed MUST crear el flag `iclass-integration` con `enabled: false` por defecto (apagado hasta validar en prod).

### REQ-FF-PORT-1: Puerto de dominio

El dominio MUST exponer `FeatureFlagRepository` en `src/domain/ports/` con:

```ts
interface FeatureFlag { key: string; enabled: boolean; updatedAt: string; }
interface FeatureFlagRepository {
  list(): Promise<FeatureFlag[]>;
  get(key: string): Promise<FeatureFlag | null>;
  setEnabled(key: string, enabled: boolean): Promise<FeatureFlag>;
}
```

### REQ-FF-READ-1: Consultar flags

#### Scenario: Listar todos los flags

**Given** un request autenticado `GET /api/admin/feature-flags`
**When** se procesa
**Then** MUST responder 200 con un array de `{ key, enabled, updatedAt }`

#### Scenario: Obtener un flag existente

**Given** un request autenticado `GET /api/admin/feature-flags/iclass-integration`
**When** se procesa
**Then** MUST responder 200 con `{ key: "iclass-integration", enabled: <bool>, updatedAt }`

#### Scenario: Flag inexistente

**Given** un request autenticado `GET /api/admin/feature-flags/no-existe`
**When** se procesa
**Then** MUST responder 404 con `{ code: "FLAG_NOT_FOUND" }`

### REQ-FF-TOGGLE-1: Deshabilitar/habilitar por API

#### Scenario: Apagar un flag persiste el cambio

**Given** un request autenticado `PATCH /api/admin/feature-flags/iclass-integration`
**And** el body es `{ "enabled": false }`
**When** se procesa
**Then** MUST responder 200 con `{ key, enabled: false, updatedAt }`
**And** un `GET` posterior MUST devolver `enabled: false`
**And** el cambio MUST sobrevivir un reinicio del proceso (persistido en DB)

#### Scenario: Body inválido es rechazado

**Given** un `PATCH /api/admin/feature-flags/iclass-integration` con body `{ "enabled": "yes" }`
**When** se procesa
**Then** MUST responder 400 con `{ code: "VALIDATION_ERROR" }`

#### Scenario: Toggle de flag inexistente

**Given** un `PATCH /api/admin/feature-flags/no-existe` con body válido
**When** se procesa
**Then** MUST responder 404 con `{ code: "FLAG_NOT_FOUND" }`

### REQ-FF-AUTH-1: Endpoints protegidos

Todas las rutas `/api/admin/feature-flags[...]` MUST exigir autenticación (mismo middleware que el resto de `/api/admin`). Sin token válido → 401.

---

## Appendix: New Error Codes

| Scenario | HTTP | `code` |
|----------|------|--------|
| Flag inexistente | 404 | `FLAG_NOT_FOUND` |
| Body inválido | 400 | `VALIDATION_ERROR` |
