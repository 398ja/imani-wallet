/**
 * Webpack Dev Server Configuration
 *
 * Configures the development server port and other settings.
 */

config.devServer = {
    ...config.devServer,
    port: 8181,
    open: true,
    hot: true,
    historyApiFallback: true
};
