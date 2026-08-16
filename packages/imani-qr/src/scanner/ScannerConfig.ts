import { defaultConfig, type ScannerConfig } from '../types/scanner';

export function resolveScannerConfig(config?: ScannerConfig): Required<ScannerConfig> {
  if (!config) {
    return { ...defaultConfig, qrbox: { ...defaultConfig.qrbox } };
  }

  return {
    ...defaultConfig,
    ...config,
    qrbox: config.qrbox ?? { ...defaultConfig.qrbox }
  };
}
