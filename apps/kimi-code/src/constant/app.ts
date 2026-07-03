import { ErrorCodes } from '@moonshot-ai/kimi-code-sdk';

export const PRODUCT_NAME = 'Nori Code';
export const CLI_COMMAND_NAME = 'nori';
export const PROCESS_NAME = 'nori-code';
export const NORI_TERMINAL_LOGO = ['█   █', '██  █', '█ █ █', '█  ██', '█   █'] as const;
export const NORI_TERMINAL_LOGO_COLOR = '#00D7D7';

// Used in telemetry app names and HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'nori-code-cli';
export const CLI_UI_MODE = 'shell';
// Telemetry ui_mode for the `nori web` / `nori server run` host. Same product
// as the CLI (CLI_USER_AGENT_PRODUCT); the surface is distinguished by ui_mode.
export const WEB_UI_MODE = 'web';

// Give telemetry a short flush window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// Upper bound on headless (`nori -p`) shutdown. A wedged cleanup step (e.g. a
// SessionEnd hook, an MCP shutdown, or a connection blackholed by a restrictive
// firewall) must not keep a completed run alive indefinitely — once this elapses
// we stop waiting on cleanup and let the run return.
export const PROMPT_CLEANUP_TIMEOUT_MS = 8000;

// Grace after a headless run has fully completed (turn done, cleanup attempted)
// before force-exiting. `nori -p` otherwise relies on the event loop draining to
// exit; a stray ref'd handle (socket/timer/child) left over from the run would
// wedge it. The guard timer is unref'd, so a healthy run still exits naturally
// well before this fires.
export const HEADLESS_FORCE_EXIT_GRACE_MS = 2000;

// Max time to wait for buffered stdout/stderr to flush before arming the
// force-exit fallback. A slow/piped consumer's still-draining stdio is a
// legitimate ref'd handle — flushing first prevents the fallback from
// truncating completed output. Bounded so a permanently-stuck consumer can't
// re-introduce the hang.
export const HEADLESS_STDIO_DRAIN_TIMEOUT_MS = 10000;

// Published npm package name; this can differ from the executable command.
export const NPM_PACKAGE_NAME = '@nori-code/cli';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
export const NORI_CODE_HOME_ENV = 'NORI_CODE_HOME';
export const NORI_CODE_DATA_DIR_NAME = '.nori-code';
export const NORI_CODE_LOG_DIR_NAME = 'logs';
export const NORI_CODE_CACHE_DIR_NAME = 'cache';
export const NORI_CODE_UPDATE_DIR_NAME = 'updates';
export const NORI_CODE_BIN_DIR_NAME = 'bin';
export const NORI_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const NORI_CODE_UPDATE_INSTALL_STATE_FILE_NAME = 'install.json';
export const NORI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME = 'install.lock';
export const NORI_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME = 'rollout.log';
export const NORI_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const NORI_CODE_BANNER_DIR_NAME = 'banner';
export const NORI_CODE_BANNER_STATE_FILE_NAME = 'state.json';

// Managed auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = '';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = '';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'nori-code-';

// Telemetry event name; keep stable for dashboard queries.
export const FEEDBACK_TELEMETRY_EVENT = 'feedback_submitted';

// CDN source of truth: all version checks and native install scripts pull from here.
export const NORI_CODE_CDN_BASE = '';
export const NORI_CODE_CDN_LATEST_URL = '';
// Rollout manifest consumed by update checks; the plain-text `/latest` above
// stays unchanged forever — already-shipped clients hard-fail on non-semver
// bodies, and the CDN install scripts read it for fresh installs.
export const NORI_CODE_CDN_LATEST_JSON_URL = '';
export const NORI_CODE_TIPS_BANNER_URL = '';
export const NORI_CODE_PLUGIN_MARKETPLACE_URL = '';
export const NORI_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'NORI_CODE_PLUGIN_MARKETPLACE_URL';
export const NORI_CODE_INSTALL_SH_URL = '';
export const NORI_CODE_INSTALL_PS1_URL = '';

// Native install commands, split by platform. Use these for prompt copy and spawn calls only; do not assemble the strings elsewhere.
export const NATIVE_INSTALL_COMMAND_UNIX = `curl -fsSL ${NORI_CODE_INSTALL_SH_URL} | bash`;
export const NATIVE_INSTALL_COMMAND_WIN = `irm ${NORI_CODE_INSTALL_PS1_URL} | iex`;
