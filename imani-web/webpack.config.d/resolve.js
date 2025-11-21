// Configure webpack to prefer ESM modules over CommonJS
// This fixes the "module is not defined" error when nostr-tools CJS version is loaded

config.resolve = config.resolve || {};

// Prefer browser-compatible module entry points - prioritize 'module' (ESM) over 'main' (CJS)
config.resolve.mainFields = ['browser', 'module', 'main'];

// Set condition names to prefer ESM exports for packages with dual ESM/CJS
config.resolve.conditionNames = ['import', 'module', 'browser', 'default'];
