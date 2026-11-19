import { ref, watch, onUnmounted, type Ref } from 'vue';
import { browser } from 'wxt/browser';
import { toDownloadError, type DownloadError } from '@/core/download-errors';

export interface DownloadStatus {
  state: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes?: number;
  paused: boolean;
  error?: DownloadError;
}

const POLL_INTERVAL_MS = 500;

/** The downloads API emits no progress events, so poll while something is still running. */
export function useDownloads(downloadIds: Ref<number[]>) {
  const statusById = ref<Record<number, DownloadStatus>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    clearTimeout(timer);
    const ids = downloadIds.value;
    const items = (await Promise.all(ids.map(id => browser.downloads.search({ id })))).flat();

    statusById.value = Object.fromEntries(items.map(item => [item.id, toStatus(item)]));
    if (items.some(item => item.state === 'in_progress')) timer = setTimeout(refresh, POLL_INTERVAL_MS);
  }

  const onChanged = () => void refresh();
  browser.downloads.onChanged.addListener(onChanged);
  watch(downloadIds, refresh, { immediate: true });

  onUnmounted(() => {
    clearTimeout(timer);
    browser.downloads.onChanged.removeListener(onChanged);
  });

  return { statusById };
}

function toStatus(item: Browser.downloads.DownloadItem): DownloadStatus {
  return {
    state: item.state as DownloadStatus['state'],
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes > 0 ? item.totalBytes : undefined,
    paused: item.paused,
    error: item.error ? toDownloadError(item.error) : undefined,
  };
}
