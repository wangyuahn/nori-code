#!/bin/bash

# Based on electron-builder's default `after-install.tpl`, with one deliberate
# change: chrome-sandbox is always installed setuid root.
#
# The upstream template probes `unshare --user true` and, when it succeeds,
# leaves chrome-sandbox at 0755 on the theory that the kernel's unprivileged
# user namespaces make the SUID helper unnecessary. That probe runs as root
# during postinst, but the app runs as the desktop user — and on Ubuntu 23.10+
# `kernel.apparmor_restrict_unprivileged_userns=1` denies userns creation to
# unconfined unprivileged processes. Root sees a working userns, the user does
# not, Chromium falls back to the SUID sandbox, finds mode 0755 and aborts:
#
#   FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was
#   found, but is not configured correctly.
#
# Mode 4755 is correct on both kinds of system: Chromium still prefers the
# namespace sandbox wherever it is actually permitted and only falls back to
# the SUID helper when it is not, so shipping the helper usable costs nothing
# and removes the root-vs-user disagreement entirely.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
