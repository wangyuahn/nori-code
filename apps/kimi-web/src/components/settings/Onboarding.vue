<!-- apps/kimi-web/src/components/settings/Onboarding.vue -->
<!-- First-run onboarding overlay: a short welcome + the language, color scheme
     and accent preferences, all of which apply live. Re-openable from the
     settings popover. Each preference can be changed any time later, so there's
     nothing to "lose". -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import { useAppearance, type Accent, type ColorScheme } from '../../composables/client/useAppearance';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import NoriLogo from '../NoriLogo.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';

const emit = defineEmits<{ complete: []; skip: [] }>();

const { t, locale } = useI18n();
const { colorScheme, accent, setColorScheme, setAccent } = useAppearance();

function chooseLocale(code: LocaleCode): void {
  if (locale.value !== code) setLocale(code);
}

function finish(): void {
  emit('complete');
}
</script>

<template>
  <Dialog
    :open="true"
    size="md"
    :close-on-overlay="false"
    :close-on-esc="false"
    @close="emit('skip')"
  >
    <template #head>
      <div class="ob-brand">
        <NoriLogo class="ob-logo" title="Nori Code" />
        <div class="ob-brand-text">
          <div class="ob-title">{{ t('onboarding.title') }}</div>
          <div class="ob-sub">{{ t('onboarding.subtitle') }}</div>
        </div>
      </div>
    </template>

    <section class="ob-sec">
      <div class="ob-label">{{ t('onboarding.languageLabel') }}</div>
      <SegmentedControl
        :model-value="locale"
        :options="availableLocales.map((l) => ({ value: l.code, label: l.label }))"
        @update:model-value="chooseLocale($event as LocaleCode)"
      />
    </section>

    <section class="ob-sec">
      <div class="ob-label">{{ t('theme.colorSchemeLabel') }}</div>
      <SegmentedControl
        :model-value="colorScheme"
        :options="[
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
          { value: 'system', label: t('theme.system') },
        ]"
        @update:model-value="setColorScheme($event as ColorScheme)"
      />
    </section>

    <section class="ob-sec">
      <div class="ob-label">{{ t('theme.accentLabel') }}</div>
      <SegmentedControl
        :model-value="accent"
        :options="[
          { value: 'blue', label: t('theme.accentBlue') },
          { value: 'mono', label: t('theme.accentBlack') },
        ]"
        @update:model-value="setAccent($event as Accent)"
      />
    </section>

    <Button variant="primary" size="lg" class="ob-start" @click="finish">{{ t('onboarding.start') }}</Button>
  </Dialog>
</template>

<style scoped>
.ob-brand {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.ob-brand-text { min-width: 0; }
.ob-logo {
  width: 52px; height: 36px; flex: none;
}
.ob-title { color: var(--color-text); font-size: var(--text-xl); font-weight: var(--weight-medium); }
.ob-sub { color: var(--color-text-muted); font-size: var(--text-base); margin-top: 1px; }

.ob-sec { margin-bottom: var(--space-4); }
.ob-label { color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-medium); margin-bottom: var(--space-2); }

/* full-width primary CTA */
.ob-start { width: 100%; }
</style>
