<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import MediaItem from './MediaItem.vue';
import { useTabMedia } from './useTabMedia';
import { useDownloads } from './useDownloads';
import { useCompanionStatus } from './useCompanionStatus';
import { t } from '@/core/i18n';
import { loadSettings, DEFAULT_SETTINGS, type Preset } from '@/core/settings';

const { tabId, media, downloadIds, isSupportedPage } = useTabMedia();
const { statusById } = useDownloads(downloadIds);
const { status: companionStatus } = useCompanionStatus();
const companionReady = computed(() => companionStatus.value?.state === 'ready');
const defaultPreset = ref<Preset>(DEFAULT_SETTINGS.preset);
const historyUrl = browser.runtime.getURL('/downloads-history.html');
onMounted(async () => {
  defaultPreset.value = (await loadSettings()).preset;
});
</script>

<template>
  <main class="popup">
    <header class="popup__header">
      <h1 class="popup__title">{{ t('popupTitle') }}</h1>
      <nav class="popup__nav">
        <a class="link" :href="historyUrl" target="_blank">{{ t('openHistory') }}</a>
        <button class="link" type="button" @click="browser.runtime.openOptionsPage()">{{ t('openSettings') }}</button>
      </nav>
    </header>

    <p v-if="!isSupportedPage" class="empty">{{ t('unsupportedPage') }}</p>

    <div v-else-if="media.length === 0" class="empty">
      <p>{{ t('emptyState') }}</p>
      <p class="empty__hint">{{ t('emptyHint') }}</p>
    </div>

    <ul v-else class="list" aria-live="polite">
      <MediaItem
        v-for="item in media"
        :key="`${item.key}|${defaultPreset}`"
        :media="item"
        :tab-id="tabId!"
        :browser-status="item.downloadId !== undefined ? statusById[item.downloadId] : undefined"
        :companion-ready="companionReady"
        :default-preset="defaultPreset"
      />
    </ul>

    <footer v-if="companionStatus" class="popup__footer" :class="{ 'popup__footer--ok': companionReady }">
      <template v-if="companionReady">{{ t('companionStatusReady', companionStatus.engineVersion ?? '?') }}</template>
      <template v-else>{{ t('companionStatusMissing') }}</template>
    </footer>
  </main>
</template>
