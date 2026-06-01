import { classifyDeviceType, isSnMacDevicePhoto } from '@application/services/classifyDeviceType';

describe('classifyDeviceType', () => {
  it('maps known device keywords', () => {
    expect(classifyDeviceType('SAQUE FOTO DE LA MAC Y SN DEL ROUTER INSTALADO')).toBe('ROUTER');
    expect(classifyDeviceType('FOTO DE LA MAC Y SN DE LA ANTENA INSTALADA')).toBe('ANTENA');
    expect(classifyDeviceType('SN de la ONU GPON')).toBe('ONU');
    expect(classifyDeviceType('serial del REPETIDOR')).toBe('REPETIDOR');
  });

  it('soft-fails unknown labels to OTROS', () => {
    expect(classifyDeviceType('SAQUE FOTO DE LA SEÑAL DEL SERVICIO')).toBe('OTROS');
    expect(classifyDeviceType('')).toBe('OTROS');
  });
});

describe('isSnMacDevicePhoto', () => {
  it('true only for SN/MAC photos of a recognizable device', () => {
    expect(isSnMacDevicePhoto('SAQUE FOTO DE LA MAC Y SN DEL ROUTER')).toBe(true);
    expect(isSnMacDevicePhoto('SAQUE FOTO DE LA SEÑAL DEL SERVICIO')).toBe(false); // no SN/MAC, OTROS
    expect(isSnMacDevicePhoto('FOTO DE LA ANTENA')).toBe(false); // device but no SN/MAC keyword
  });
});
