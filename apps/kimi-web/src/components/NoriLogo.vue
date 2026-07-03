<!-- apps/kimi-web/src/components/NoriLogo.vue -->
<!-- Simple Nori mark: a rounded plate with an N-shaped loop path and two nodes. -->
<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

withDefaults(defineProps<{
  title?: string;
  decorative?: boolean;
  interactive?: boolean;
  dev?: boolean;
}>(), {
  title: 'Nori Code',
  decorative: false,
  interactive: false,
  dev: false,
});

const emit = defineEmits<{
  click: [event: MouseEvent];
  pointerdown: [event: PointerEvent];
  pointerup: [event: PointerEvent];
  pointercancel: [event: PointerEvent];
}>();

const svgRef = ref<SVGSVGElement | null>(null);
let blinkTimer: ReturnType<typeof setTimeout> | undefined;

function blink(): void {
  const el = svgRef.value;
  if (!el) return;
  el.classList.remove('blink-now');
  void el.getBoundingClientRect();
  el.classList.add('blink-now');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => el.classList.remove('blink-now'), 300);
}

onUnmounted(() => {
  clearTimeout(blinkTimer);
});

defineExpose({ blink, el: svgRef });
</script>

<template>
  <svg
    ref="svgRef"
    class="nori-logo"
    :class="{ 'is-interactive': interactive, 'is-dev': dev }"
    viewBox="0 0 32 22"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : title"
    :aria-hidden="decorative ? 'true' : undefined"
    @click="emit('click', $event)"
    @pointerdown="emit('pointerdown', $event)"
    @pointerup="emit('pointerup', $event)"
    @pointercancel="emit('pointercancel', $event)"
  >
    <title v-if="!decorative">{{ title }}</title>
    <rect class="nori-logo__plate" x="1" y="1" width="30" height="20" rx="6" />
    <path class="nori-logo__thread" d="M8 15V7l16 8V7" />
    <circle class="nori-logo__node nori-logo__node--left" cx="8" cy="15" r="1.65" />
    <circle class="nori-logo__node nori-logo__node--right" cx="24" cy="7" r="1.65" />
  </svg>
</template>

<style scoped>
.nori-logo {
  --nori-logo-fill: var(--logo);
  --nori-logo-ink: var(--bg);
  display: block;
  width: 32px;
  height: 22px;
  flex: none;
  color: var(--nori-logo-fill);
}
.nori-logo.is-dev {
  --nori-logo-fill: var(--color-logo-dev);
  --nori-logo-ink: var(--color-text);
}
.nori-logo.is-interactive {
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.nori-logo__plate {
  fill: currentColor;
}
.nori-logo__thread {
  fill: none;
  stroke: var(--nori-logo-ink);
  stroke-width: 2.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nori-logo__node {
  fill: var(--nori-logo-ink);
  transform-box: fill-box;
  transform-origin: center;
  animation: nori-node-breathe 7s var(--ease-in-out) infinite;
}
.nori-logo__node--right {
  animation-delay: 700ms;
}
.nori-logo.blink-now .nori-logo__thread {
  animation: nori-line-flash 0.24s var(--ease-out);
}
.nori-logo.blink-now .nori-logo__node {
  animation: nori-node-tap 0.24s var(--ease-out);
}

@keyframes nori-node-breathe {
  0%, 68%, 100% { transform: scale(1); }
  74%, 82% { transform: scale(1.28); }
}
@keyframes nori-line-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.46; }
}
@keyframes nori-node-tap {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.42); }
}
@media (prefers-reduced-motion: reduce) {
  .nori-logo__node,
  .nori-logo.blink-now .nori-logo__thread,
  .nori-logo.blink-now .nori-logo__node {
    animation: none;
  }
}
</style>
