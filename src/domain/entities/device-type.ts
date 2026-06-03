/** The device classes we track for installed inventory. */
export type DeviceType = 'ONU' | 'ROUTER' | 'ANTENA' | 'REPETIDOR' | 'OTROS';

export const VALID_DEVICE_TYPES: readonly DeviceType[] = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];
