'use strict';

const notarize = process.env.NORI_DESKTOP_NOTARIZE === 'true';

module.exports = {
  // A stable, standalone Nori identity used by electron-builder.
  // derives Windows application identity and installer metadata from this ID.
  appId: 'com.nori.work',
  productName: 'Nori Work',
  executableName: 'NoriWork',
  copyright: 'Copyright © Nori',

  directories: { output: 'dist-app' },
  npmRebuild: false,
  asar: true,
  files: ['out/**', 'package.json'],
  beforePack: './scripts/before-pack.cjs',
  extraResources: [
    { from: 'resources-stage/bin', to: 'bin' },
    { from: 'resources-stage/nori-web', to: 'nori-web' },
    { from: 'build/icon.png', to: 'icon.png' },
  ],

  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: ['dmg', 'zip'],
    artifactName: 'Nori-Work-${version}-${arch}.${ext}',
    notarize,
    protocols: [{ name: 'Nori Work', schemes: ['nori-work'] }],
  },

  win: {
    icon: 'build/icon.ico',
    target: ['nsis'],
    artifactName: 'Nori-Work-${version}-${arch}.${ext}',
    protocols: [{ name: 'Nori Work', schemes: ['nori-work'] }],
  },

  nsis: {
    // Stable, Nori-only GUID prevents collisions with unrelated applications.
    guid: 'af4f85b3-4b85-5fac-8768-243f81adad55',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Nori Work',
    uninstallDisplayName: 'Nori Work',
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
  },

  linux: {
    icon: 'build/icon.png',
    executableName: 'nori-work',
    category: 'Development',
    target: ['AppImage', 'deb'],
    artifactName: 'Nori-Work-${version}-${arch}.${ext}',
    maintainer: 'Nori',
    protocols: [{ name: 'Nori Work', schemes: ['nori-work'] }],
  },

  publish: {
    provider: 'github',
    owner: 'wangyuahn',
    repo: 'nori-code',
    releaseType: 'draft',
  },
};
