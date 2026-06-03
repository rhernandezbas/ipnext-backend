/**
 * Device-type classification lives in the DeviceTypeCatalog entity now.
 * The closed union `DeviceType` and its `VALID_DEVICE_TYPES` array have been
 * removed (D.11 — dynamic-validation refactor). Use `DeviceTypeCatalogRepository.listActiveNames()`
 * or `DeviceTypeCatalogService.isValid()` / `ensure()` instead.
 */
