// apps/kimi-web/src/composables/useAuthGate.ts
// Auth readiness gates the main app. Once the first load finishes and auth is
// still missing, show a full-page login entry instead of an in-app banner.

import { computed, ref, watch, type Ref } from 'vue';
import type { useKimiWebClient } from './useKimiWebClient';

type KimiWebClient = ReturnType<typeof useKimiWebClient>;
type BlinkableLogo = { blink: () => void };

export interface UseAuthGateOptions {
  client: KimiWebClient;
  /** Template ref to the auth-page logo component; owned by App.vue so the
      blink handler can drive the brand mark without knowing its SVG internals. */
  authLogoRef: Ref<BlinkableLogo | null>;
}

export function useAuthGate({ client, authLogoRef }: UseAuthGateOptions) {
  const authReady = computed(() => client.authReady.value);
  const showAuthGate = computed(() => client.initialized.value && !authReady.value);
  const LOGIN_PATH = '/login';
  const authReturnPath = ref<string | null>(null);

  function currentPathWithSuffix(): string {
    if (typeof window === 'undefined') return '/';
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function replaceBrowserPath(path: string): void {
    if (typeof window === 'undefined') return;
    window.history.replaceState(window.history.state, '', path);
  }

  watch(showAuthGate, (show) => {
    if (typeof window === 'undefined') return;
    if (show) {
      if (window.location.pathname !== LOGIN_PATH) {
        authReturnPath.value = currentPathWithSuffix();
        replaceBrowserPath(LOGIN_PATH);
      }
      return;
    }
    if (window.location.pathname === LOGIN_PATH) {
      replaceBrowserPath(authReturnPath.value ?? '/');
      authReturnPath.value = null;
    }
  }, { immediate: true });

  function blinkAuthLogo(): void {
    authLogoRef.value?.blink();
  }

  return { showAuthGate, blinkAuthLogo };
}
