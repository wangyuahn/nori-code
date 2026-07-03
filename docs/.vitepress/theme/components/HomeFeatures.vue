<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

const { lang } = useData()
const isZh = computed(() => lang.value.startsWith('zh'))

interface Highlight {
  icon: string
  title: string
  desc: string
}

interface Feature {
  icon: string
  title: string
  desc: string
  href: string
}

const highlights = computed<Highlight[]>(() => isZh.value
  ? [
      {
        icon: '⚡',
        title: '极速轻量',
        desc: '一行命令装好的单文件 CLI，毫秒级启动，无需 Node.js，零环境干扰。',
      },
      {
        icon: '🎬',
        title: '视频也能输入',
        desc: '屏幕录像、演示视频拖进对话——画面替你说清需求。',
      },
      {
        icon: '🎨',
        title: '精致 TUI',
        desc: '为长时间、专注的 Agent 会话精心打磨的交互界面。',
      },
    ]
  : [
      {
        icon: '⚡',
        title: 'Fast & lightweight',
        desc: 'Single-binary install with millisecond startup — no Node.js, no PATH gymnastics.',
      },
      {
        icon: '🎬',
        title: 'Video input',
        desc: 'Drop a screen recording or demo clip in chat; the agent reads the frames and acts on them.',
      },
      {
        icon: '🎨',
        title: 'Polished TUI',
        desc: 'A carefully tuned interface designed for long, focused agent sessions.',
      },
    ])

const features = computed<Feature[]>(() => isZh.value
  ? [
      {
        icon: '🧩',
        title: 'Agent Skills',
        desc: '把团队的工作流程封装成 Kimi 随时调用的技能，不必每次都重新解释。',
        href: '/zh/customization/skills',
      },
      {
        icon: '🪝',
        title: 'Hooks',
        desc: '在生命周期关键点注入脚本，做格式化、审批、通知或任意自定义逻辑。',
        href: '/zh/customization/hooks',
      },
      {
        icon: '🤖',
        title: 'Sub-agents',
        desc: '并行派发独立任务，每个子 agent 自带上下文，主对话保持清爽。',
        href: '/zh/customization/agents',
      },
      {
        icon: '🔌',
        title: 'MCP',
        desc: '通过 Model Context Protocol 接入任意工具、数据源与企业系统。',
        href: '/zh/customization/mcp',
      }
    ]
  : [
      {
        icon: '🧩',
        title: 'Agent Skills',
        desc: "Package your team's workflows into skills Kimi can invoke on demand.",
        href: '/en/customization/skills',
      },
      {
        icon: '🪝',
        title: 'Hooks',
        desc: 'Inject scripts at lifecycle checkpoints — formatting, approvals, notifications, anything.',
        href: '/en/customization/hooks',
      },
      {
        icon: '🤖',
        title: 'Sub-agents',
        desc: 'Dispatch isolated tasks in parallel, each with its own context — main thread stays clean.',
        href: '/en/customization/agents',
      },
      {
        icon: '🔌',
        title: 'MCP',
        desc: 'Plug in any tool, data source, or enterprise system via the Model Context Protocol.',
        href: '/en/customization/mcp',
      }
    ])

const highlightsTitle = computed(() => isZh.value ? '开箱即得' : 'Ready out of the box')
const highlightsLede = computed(() => isZh.value
  ? '装好就能用，关键能力默认就绪。'
  : 'Install once. The essentials are already there.')

const featuresTitle = computed(() => isZh.value ? '按需扩展' : 'Extend it your way')
const featuresLede = computed(() => isZh.value
  ? '内置可编程的扩展点，按自己的方式塑造工作流。'
  : 'Programmable extension points to shape the workflow around you.')

const ctaText = computed(() => isZh.value ? '了解' : 'Learn more')
</script>

<template>
  <section class="KimiHome__section KimiHighlights">
    <h2 class="KimiHome__sectionTitle">{{ highlightsTitle }}</h2>
    <p class="KimiHome__sectionLede">{{ highlightsLede }}</p>
    <div class="KimiHighlights__grid">
      <div
        v-for="h in highlights"
        :key="h.title"
        class="KimiHighlights__card"
      >
        <div class="KimiHighlights__icon" aria-hidden="true">{{ h.icon }}</div>
        <h3 class="KimiHighlights__title">{{ h.title }}</h3>
        <p class="KimiHighlights__desc">{{ h.desc }}</p>
      </div>
    </div>
  </section>

  <section class="KimiHome__section KimiFeatures">
    <h2 class="KimiHome__sectionTitle">{{ featuresTitle }}</h2>
    <p class="KimiHome__sectionLede">{{ featuresLede }}</p>
    <div class="KimiFeatures__grid">
      <a
        v-for="f in features"
        :key="f.title"
        class="KimiFeatures__card"
        :href="withBase(f.href)"
      >
        <div class="KimiFeatures__icon" aria-hidden="true">{{ f.icon }}</div>
        <h3 class="KimiFeatures__title">{{ f.title }}</h3>
        <p class="KimiFeatures__desc">{{ f.desc }}</p>
        <span class="KimiFeatures__cta">
          {{ ctaText }}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </a>
    </div>
  </section>
</template>

<style scoped>
/* === Highlights (top section: non-clickable product attributes) === */
.KimiHighlights__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 720px) {
  .KimiHighlights__grid {
    grid-template-columns: 1fr;
  }
}

.KimiHighlights__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 22px 22px 24px;
  border-radius: var(--kimi-radius-card);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.KimiHighlights__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--kimi-brand-soft);
  font-size: 18px;
  margin-bottom: 14px;
}

.KimiHighlights__title {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
  color: var(--vp-c-text-1);
}

.KimiHighlights__desc {
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0;
}

/* === Features (bottom section: clickable extension points) === */
.KimiFeatures__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
}

@media (max-width: 1024px) {
  .KimiFeatures__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .KimiFeatures__grid {
    grid-template-columns: 1fr;
  }
}

.KimiFeatures__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 28px 24px 26px;
  border-radius: var(--kimi-radius-card);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform var(--kimi-transition), border-color var(--kimi-transition),
              box-shadow var(--kimi-transition), background var(--kimi-transition);
  overflow: hidden;
}

.KimiFeatures__card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--kimi-brand-gradient-soft);
  opacity: 0;
  transition: opacity var(--kimi-transition);
  pointer-events: none;
  border-radius: inherit;
}

.KimiFeatures__card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--vp-shadow-3);
}
.KimiFeatures__card:hover::before {
  opacity: 1;
}

.KimiFeatures__icon {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--kimi-brand-soft);
  font-size: 22px;
  margin-bottom: 18px;
}

.KimiFeatures__title {
  position: relative;
  z-index: 1;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 0 0 8px;
  color: var(--vp-c-text-1);
}

.KimiFeatures__desc {
  position: relative;
  z-index: 1;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 20px;
}

.KimiFeatures__cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  margin-top: auto;
  transition: transform var(--kimi-transition);
}

.KimiFeatures__card:hover .KimiFeatures__cta {
  transform: translateX(3px);
}
</style>
