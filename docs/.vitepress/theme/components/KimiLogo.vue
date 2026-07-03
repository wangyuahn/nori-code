<script setup lang="ts">
import logoUrl from '../Kimi.png'

withDefaults(defineProps<{ size?: number }>(), { size: 56 })
</script>

<template>
  <img
    class="KimiLogo"
    :src="logoUrl"
    :width="size"
    :height="size"
    alt="Kimi"
  />
</template>

<style scoped>
.KimiLogo {
  display: block;
  object-fit: contain;
}
</style>
