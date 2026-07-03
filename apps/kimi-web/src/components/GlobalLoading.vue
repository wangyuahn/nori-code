<!-- apps/kimi-web/src/components/GlobalLoading.vue -->
<!-- Full-screen splash shown on first load until the client has talked to the
     daemon, so a page refresh doesn't flash a half-rendered, not-yet-connected
     app. Hidden once useKimiWebClient.initialized flips true. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import NoriLogo from './NoriLogo.vue';
import Spinner from './ui/Spinner.vue';
const { t } = useI18n();
</script>

<template>
  <div class="gload" role="status" :aria-label="t('app.connecting')">
    <div class="gload-box">
      <div class="gload-brand" aria-hidden="true">
        <NoriLogo class="gload-logo" decorative />
        <span class="gload-word">Nori Code</span>
      </div>
      <Spinner size="md" :label="t('app.connecting')" />
      <div class="gload-text">{{ t('app.connecting') }}</div>
    </div>
  </div>
</template>

<style scoped>
.gload {
  position: fixed;
  top: 0;
  left: 0;
  /* Viewport units for size + position so the splash always fills the screen,
     even if a transformed/collapsed <html> would otherwise shrink a fixed box. */
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  min-width: 100vw;
  min-height: 100dvh;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.gload-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  /* nudge slightly above center — feels more intentional than dead-center */
  transform: translateY(-6%);
}
.gload-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  animation: gload-pop 0.55s var(--ease-out) both;
}
.gload-logo {
  width: 64px;
  height: 44px;
}
.gload-word {
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  color: var(--color-text);
  letter-spacing: 0;
}
.gload-text {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--muted);
  letter-spacing: 0;
}
@keyframes gload-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .gload-brand { animation: none; }
}
</style>
