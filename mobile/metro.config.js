// Expo's default Metro config. The dashboard/ folder is excluded so web export
// does not try to bundle React DOM views into the native app.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
config.resolver.blockList = [new RegExp(`${path.resolve(__dirname, '..', 'dashboard').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`)];
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'sqlite'])];
module.exports = config;
