<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'
import KimiLogo from './KimiLogo.vue'

const { lang } = useData()

const isZh = computed(() => lang.value.startsWith('zh'))

const copy = computed(() => isZh.value
  ? {
      titleLead: 'Kimi',
      titleAccent: 'Code',
      titleTail: ' CLI',
      tagline: 'The Starting Point for Next-Gen Agents',
      primaryText: '开始使用',
      primaryHref: '/zh/guides/getting-started',
      secondaryText: '在 GitHub 查看',
      secondaryHref: 'https://github.com/MoonshotAI/kimi-code',
    }
  : {
      titleLead: 'Kimi',
      titleAccent: 'Code',
      titleTail: ' CLI',
      tagline: 'The Starting Point for Next-Gen Agents',
      primaryText: 'Get started',
      primaryHref: '/en/guides/getting-started',
      secondaryText: 'View on GitHub',
      secondaryHref: 'https://github.com/MoonshotAI/kimi-code',
    })
</script>

<template>
  <section class="KimiHero">
    <div class="KimiHero__halo" aria-hidden="true" />
    <div class="KimiHero__inner">
      <div class="KimiHero__logo">
        <KimiLogo :size="64" />
      </div>
      <h1 class="KimiHero__title">
        {{ copy.titleLead }}&nbsp;<span class="KimiHero__accent">{{ copy.titleAccent }}</span>{{ copy.titleTail }}
      </h1>
      <p class="KimiHero__tagline">{{ copy.tagline }}</p>
      <div class="KimiHero__actions">
        <a class="KimiBtn KimiBtn--primary" :href="withBase(copy.primaryHref)">
          {{ copy.primaryText }}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </a>
        <a class="KimiBtn KimiBtn--ghost" :href="copy.secondaryHref" target="_blank" rel="noopener">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 .2C3.58.2 0 3.78 0 8.2c0 3.54 2.3 6.54 5.48 7.6.4.07.55-.17.55-.38l-.01-1.5c-2.23.49-2.7-.95-2.7-.95-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.81.06 1.24.83 1.24.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.65 7.65 0 014 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.55.74.55 1.49l-.01 2.21c0 .21.15.46.55.38C13.7 14.74 16 11.74 16 8.2 16 3.78 12.42.2 8 .2z" />
          </svg>
          {{ copy.secondaryText }}
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.KimiHero {
  position: relative;
  padding: clamp(72px, 12vw, 140px) 0 clamp(48px, 8vw, 96px);
  overflow: hidden;
}

.KimiHero__halo {
  position: absolute;
  top: -120px;
  left: 50%;
  width: 900px;
  height: 600px;
  transform: translateX(-50%);
  background:
    radial-gradient(closest-side, rgba(10, 122, 255, 0.22), transparent 70%),
    radial-gradient(closest-side, rgba(129, 196, 255, 0.20) 30%, transparent 75%);
  filter: blur(40px);
  pointer-events: none;
  z-index: 0;
  opacity: 0.55;
}
:global(.dark) .KimiHero__halo {
  opacity: 0.85;
  background:
    radial-gradient(closest-side, rgba(61, 149, 255, 0.36), transparent 70%),
    radial-gradient(closest-side, rgba(129, 196, 255, 0.30) 30%, transparent 75%);
}

.KimiHero__inner {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.KimiHero__logo {
  margin-bottom: 28px;
  filter: drop-shadow(0 12px 32px rgba(10, 122, 255, 0.28));
}

.KimiHero__title {
  font-size: clamp(40px, 7vw, 84px);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1.05;
  margin: 0 0 20px;
  color: var(--vp-c-text-1);
  max-width: 18ch;
}

.KimiHero__accent {
  background: var(--kimi-brand-gradient);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

.KimiHero__tagline {
  font-size: clamp(16px, 1.5vw, 20px);
  line-height: 1.55;
  color: var(--vp-c-text-2);
  max-width: 620px;
  margin: 0 0 40px;
}

.KimiHero__actions {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: center;
}

@media (max-width: 480px) {
  .KimiHero__actions {
    width: 100%;
    flex-direction: column;
  }
  .KimiHero__actions .KimiBtn {
    width: 100%;
  }
}
</style>
