import { ref, computed, onMounted, onUnmounted } from 'vue';
import { browser } from 'wxt/browser';
import type { DetectedMedia } from '@/core/media-classifier';
import { visibleMedia } from '@/core/tab-media';
import { readTabMedia, tabIdFromStorageKey } from '@/core/tab-media-store';

export function useTabMedia() {
  const tabId = ref<number | null>(null);
  const isSupportedPage = ref(true);
  const allMedia = ref<DetectedMedia[]>([]);
  const media = computed(() => [...visibleMedia(allMedia.value)].reverse());

  async function reload() {
    if (tabId.value !== null) allMedia.value = await readTabMedia(tabId.value);
  }

  function onStorageChanged(changes: Record<string, unknown>, area: string) {
    if (area !== 'session') return;
    const touchesThisTab = Object.keys(changes).some(key => tabIdFromStorageKey(key) === tabId.value);
    if (touchesThisTab) void reload();
  }

  onMounted(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId.value = tab?.id ?? null;
    isSupportedPage.value = /^https?:/.test(tab?.url ?? 'https:');
    await reload();
    browser.storage.onChanged.addListener(onStorageChanged);
  });

  onUnmounted(() => browser.storage.onChanged.removeListener(onStorageChanged));

  return { media, isSupportedPage };
}
