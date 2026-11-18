<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DetectedMedia } from '@/core/media-classifier';
import { displayName, formatBytes } from '@/core/format';
import { t, type MessageKey } from '@/core/i18n';

const props = defineProps<{ media: DetectedMedia }>();

const KIND_LABEL: Record<DetectedMedia['kind'], MessageKey> = {
  progressive: 'kindProgressive',
  hls: 'kindHls',
  dash: 'kindDash',
};
const PROTECTION_LABEL: Record<DetectedMedia['protection'], MessageKey> = {
  clear: 'protectionClear',
  protected: 'protectionProtected',
  unknown: 'protectionUnknown',
};

const name = computed(() => displayName(props.media.url));
const host = computed(() => new URL(props.media.url).host);
const size = computed(() => formatBytes(props.media.sizeBytes, navigator.language));
const isProtected = computed(() => props.media.protection === 'protected');
const justCopied = ref(false);

async function copyUrl() {
  await navigator.clipboard.writeText(props.media.url);
  justCopied.value = true;
  setTimeout(() => (justCopied.value = false), 1500);
}
</script>

<template>
  <li class="item" :class="{ 'item--protected': isProtected }">
    <div class="item__main">
      <span class="item__name" :title="media.url">{{ name }}</span>
      <span class="item__meta">
        <span class="tag">{{ t(KIND_LABEL[media.kind]) }}</span>
        <span class="tag" :class="`tag--${media.protection}`">{{ t(PROTECTION_LABEL[media.protection]) }}</span>
        <span>{{ host }}</span>
        <span v-if="size">· {{ size }}</span>
      </span>
      <span v-if="isProtected" class="item__note">{{ t('drmExplanation') }}</span>
    </div>
    <button v-if="!isProtected" class="button" type="button" @click="copyUrl">
      {{ justCopied ? t('copied') : t('copyUrl') }}
    </button>
  </li>
</template>
