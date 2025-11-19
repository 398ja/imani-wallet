// Webpack configuration for production optimization
// This file is automatically merged with the default Kotlin/JS webpack config

config.optimization = {
    ...config.optimization,

    // Enable production optimizations
    minimize: true,

    // Split vendor code into separate chunks
    splitChunks: {
        chunks: 'all',
        cacheGroups: {
            // Kotlin standard library
            kotlinStdlib: {
                test: /[\\/]node_modules[\\/]kotlin/,
                name: 'kotlin-stdlib',
                priority: 30,
                reuseExistingChunk: true
            },
            // Compose runtime
            compose: {
                test: /[\\/]node_modules[\\/]@jetbrains[\\/]compose/,
                name: 'compose-runtime',
                priority: 20,
                reuseExistingChunk: true
            },
            // Other vendor code
            vendors: {
                test: /[\\/]node_modules[\\/]/,
                name: 'vendors',
                priority: 10,
                reuseExistingChunk: true
            }
        }
    },

    // Optimize module IDs for better caching
    moduleIds: 'deterministic',

    // Minimize runtime chunk
    runtimeChunk: 'single',

    // Use content hash for long-term caching
    chunkIds: 'deterministic'
};

// Production-specific optimizations
if (config.mode === 'production') {
    // Tree shaking
    config.optimization.usedExports = true;
    config.optimization.sideEffects = true;

    // Remove duplicate modules
    config.optimization.providedExports = true;
    config.optimization.innerGraph = true;

    // Concatenate modules when possible
    config.optimization.concatenateModules = true;
}

// Reduce bundle size warnings threshold
config.performance = {
    ...config.performance,
    maxEntrypointSize: 512000, // 500KB
    maxAssetSize: 512000,
    hints: 'warning'
};
