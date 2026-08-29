'use strict';

const notarize = process.env.NORI_DESKTOP_NOTARIZE === 'true';

// Chromium's SUID sandbox cannot survive a space in its own install path, so the
// Linux build needs a space-free product name.
//
// SetuidSandboxHost::PrependWrapper() passes the chrome-sandbox path to
// base::CommandLine::PrependWrapper(), which splits the string on whitespace so
// that a wrapper such as "valgrind --leak-check=full" can carry its own
// arguments. Under productName "Nori Work" the helper installs to
// /opt/Nori Work/chrome-sandbox, that split yields "/opt/Nori" +
// "Work/chrome-sandbox", and the zygote dies before the app starts:
//
//   LaunchProcess: failed to execvp: /opt/Nori
//   FATAL:zygote_host_impl_linux.cc(207)] Check failed: .
//
// electron-builder derives the /opt directory from sanitizedProductName
// (FpmTarget), exposes no linux.productName override, and rejects
// linux.desktop.Exec outright, so productName is the only lever. Rename it for
// Linux only and restore the visible name through linux.desktop below. The
// in-app product name (brand.ts NORI_PRODUCT_NAME) is unaffected.
const productName = process.platform === 'linux' ? 'NoriWork' : 'Nori Work';

module.exports = {
  // A stable, standalone Nori identity used by electron-builder.
  // derives Windows application identity and installer metadata from this ID.
  appId: 'com.nori.work',
  productName,
  executableName: 'NoriWork',
  copyright: 'Copyright © Nori',

  directories: { output: 'dist-app' },
  npmRebuild: false,
  asar: true,
  files: [
    'out/**',
    '!out/server-worker.cjs',
    '!out/server-worker.manifest.json',
    'package.json',
  ],
  beforePack: './scripts/before-pack.cjs',
  extraResources: [
    { from: 'resources-stage/server-runtime', to: 'server-runtime' },
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
    include: 'build/installer.nsh',
  },

  linux: {
    // A directory, not a single PNG: electron-builder installs one hicolor
    // entry per file, and launchers only look at the standard sizes. Shipping
    // just build/icon.png landed a lone 1024x1024 entry that no icon theme
    // resolves, so the launcher fell back to a generic cog.
    icon: 'build/icons',
    executableName: 'nori-work',
    category: 'Development',
    target: ['AppImage', 'deb'],
    artifactName: 'Nori-Work-${version}-${arch}.${ext}',
    maintainer: 'Nori',
    protocols: [{ name: 'Nori Work', schemes: ['nori-work'] }],
    // productName is 'NoriWork' on Linux to keep the space out of the install
    // path; these two keys are what the user actually sees, so pin them back to
    // the real name. Both default to productName, and StartupWMClass must keep
    // its previous value or the running window stops matching this entry.
    desktop: {
      Name: 'Nori Work',
      StartupWMClass: 'Nori Work',
    },
  },

  deb: {
    // Pin the Debian package name. AppInfo.linuxPackageName falls back to
    // sanitizedProductName whenever package.json's name is scoped (ours is
    // @nori-code/nori-work), so the productName rename above silently turned the
    // package into 'noriwork'. dpkg would then treat it as an unrelated package:
    // the old /opt/Nori Work tree would survive the install and both packages
    // would claim /usr/bin/nori-work. Naming it here keeps upgrades working and
    // decouples the package name from productName for good.
    packageName: 'nori-work',
    // Replaces electron-builder's after-install.tpl so chrome-sandbox is always
    // setuid root; see the script's header for why the upstream probe is wrong
    // on Ubuntu 23.10+.
    afterInstall: 'build/deb-after-install.sh',
  },

  publish: {
    provider: 'github',
    owner: 'wangyuahn',
    repo: 'nori-code',
    releaseType: 'draft',
  },
};
