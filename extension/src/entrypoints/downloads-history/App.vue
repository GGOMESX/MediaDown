<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { readHistory, clearHistory, type HistoryEntry } from '@/core/history';
import { loadSettings } from '@/core/settings';
import { formatBytes } from '@/core/format';
import { t } from '@/core/i18n';

const entries = ref<HistoryEntry[]>([]);
const keepHistory = ref(true);
const locale = navigator.language;
const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
const isEmpty = computed(() => entries.value.length === 0);

async function reload() {
  entries.value = await readHistory();
}

function onStorageChanged(changes: Record<string, unknown>, area: string) {
  if (area === 'local' && 'history' in changes) void reload();
}

onMounted(async () => {
  keepHistory.value = (await loadSettings()).keepHistory;
  await reload();
  browser.storage.onChanged.addListener(onStorageChanged);
});
onUnmounted(() => browser.storage.onChanged.removeListener(onStorageChanged));

async function clearAll() {
  if (!confirm(t('historyClearConfirm'))) return;
  await clearHistory();
  await reload();
}

const reveal = (entry: HistoryEntry) => entry.downloadId !== undefined && browser.downloads.show(entry.downloadId);
</script>

<template>
  <main class="options history">
    <header class="history__header">
      <h1 class="options__title">{{ t('historyTitle') }}</h1>
      <button v-if="!isEmpty" class="button button--secondary" type="button" @click="clearAll">{{ t('historyClear') }}</button>
    </header>
    <p class="field__hint">{{ t('historyPrivacy') }}</p>
    <p v-if="!keepHistory" class="item__note">{{ t('historyDisabled') }}</p>

    <p v-if="isEmpty" class="empty">{{ t('historyEmpty') }}</p>
    <ul v-else class="list history__list">
      <li v-for="entry in entries" :key="entry.id" class="item">
        <div class="item__row">
          <div class="item__main">
            <span class="item__name" :title="entry.fileName">{{ entry.fileName }}</span>
            <span class="item__meta">
              <span>{{ dateFormat.format(entry.completedAt) }}</span>
              <span v-if="entry.pageHost">· {{ entry.pageHost }}</span>
              <span v-if="entry.sizeBytes">· {{ formatBytes(entry.sizeBytes, locale) }}</span>
              <span class="tag">{{ entry.via === 'browser' ? t('historyViaBrowser') : t('historyViaCompanion') }}</span>
            </span>
            <span v-if="entry.pageTitle" class="item__hint">{{ entry.pageTitle }}</span>
          </div>
          <button v-if="entry.downloadId !== undefined" class="link" type="button" @click="reveal(entry)">{{ t('showInFolder') }}</button>
        </div>
      </li>
    </ul>
  </main>
</template>
