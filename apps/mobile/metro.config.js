const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo's Metro file map can miss its absolute empty-module path in a pnpm
// workspace stored under OneDrive. Keep the shim inside the project root so
// both the crawler and on-demand resolver can always see it.
config.resolver.emptyModulePath = path.resolve(__dirname, 'src/metro-empty-module.js');

module.exports = config;
