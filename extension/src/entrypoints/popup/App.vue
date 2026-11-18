<script setup lang="ts">
import MediaItem from './MediaItem.vue';
import { useTabMedia } from './useTabMedia';
import { t } from '@/core/i18n';

const { media, isSupportedPage } = useTabMedia();
</script>

<template>
  <main class="popup">
    <h1 class="popup__title">{{ t('popupTitle') }}</h1>

    <p v-if="!isSupportedPage" class="empty">{{ t('unsupportedPage') }}</p>

    <div v-else-if="media.length === 0" class="empty">
      <p>{{ t('emptyState') }}</p>
      <p class="empty__hint">{{ t('emptyHint') }}</p>
    </div>

    <ul v-else class="list" aria-live="polite">
      <MediaItem v-for="item in media" :key="item.key" :media="item" />
    </ul>
  </main>
</template>
