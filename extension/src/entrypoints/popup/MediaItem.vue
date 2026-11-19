<script setup lang="ts">
import { computed, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { DetectedMedia } from '@/core/media-classifier';
import type { DownloadRequest, DownloadResponse } from '@/core/messages';
import { isRetryable } from '@/core/download-errors';
import { displayName, formatBytes } from '@/core/format';
import { t, DOWNLOAD_ERROR_MESSAGE, REFUSAL_MESSAGE, type MessageKey } from '@/core/i18n';
import type { DownloadStatus } from './useDownloads';

const props = defineProps<{ media: DetectedMedia; tabId: number; download?: DownloadStatus }>();

const KIND_LABEL: Record<DetectedMedia['kind'], MessageKey> = { progressive: 'kindProgressive', hls: 'kindHls', dash: 'kindDash' };
const PROTECTION_LABEL: Record<DetectedMedia['protection'], MessageKey> = {
  clear: 'protectionClear',
  protected: 'protectionProtected',
  unknown: 'protectionUnknown',
};

const locale = navigator.language;
const name = computed(() => displayName(props.media.url));
const host = computed(() => new URL(props.media.url).host);
const size = computed(() => formatBytes(props.download?.totalBytes ?? props.media.sizeBytes, locale));
const isProtected = computed(() => props.media.protection === 'protected');
const canDownload = computed(() => props.media.kind === 'progressive' && props.media.protection === 'clear');
const refusal = ref<MessageKey | null>(null);
const starting = ref(false);
const justCopied = ref(false);

const progressPercent = computed(() => {
  const status = props.download;
  if (!status?.totalBytes) return null;
  return Math.min(100, Math.round((status.bytesReceived / status.totalBytes) * 100));
});

const progressLabel = computed(() => {
  const status = props.download;
  if (!status) return '';
  const received = formatBytes(status.bytesReceived || 1, locale);
  return status.totalBytes ? t('progressOf', [received, formatBytes(status.totalBytes, locale)]) : t('progressReceived', received);
});

const errorMessage = computed(() => {
  if (refusal.value) return t(refusal.value);
  const error = props.download?.state === 'interrupted' ? props.download.error : undefined;
  return error ? t(DOWNLOAD_ERROR_MESSAGE[error]) : '';
});

const actionLabel = computed<MessageKey>(() => {
  const status = props.download;
  if (status?.state !== 'interrupted') return 'download';
  return status.error && isRetryable(status.error) ? 'retry' : 'downloadAgain';
});

async function startDownload() {
  starting.value = true;
  refusal.value = null;
  const request: DownloadRequest = { type: 'download', tabId: props.tabId, mediaKey: props.media.key };
  try {
    const response = (await browser.runtime.sendMessage(request)) as DownloadResponse | undefined;
    if (!response?.ok) refusal.value = REFUSAL_MESSAGE[response?.reason ?? 'failed'];
  } finally {
    starting.value = false;
  }
}

async function copyUrl() {
  await navigator.clipboard.writeText(props.media.url);
  justCopied.value = true;
  setTimeout(() => (justCopied.value = false), 1500);
}

const cancel = () => props.media.downloadId !== undefined && browser.downloads.cancel(props.media.downloadId);
const showInFolder = () => props.media.downloadId !== undefined && browser.downloads.show(props.media.downloadId);
</script>

<template>
  <li class="item" :class="{ 'item--protected': isProtected }">
    <div class="item__row">
      <div class="item__main">
        <span class="item__name" :title="media.url">{{ name }}</span>
        <span class="item__meta">
          <span class="tag">{{ t(KIND_LABEL[media.kind]) }}</span>
          <span class="tag" :class="`tag--${media.protection}`">{{ t(PROTECTION_LABEL[media.protection]) }}</span>
          <span>{{ host }}</span>
          <span v-if="size">· {{ size }}</span>
        </span>
      </div>

      <div v-if="!isProtected" class="item__actions">
        <template v-if="canDownload">
          <button v-if="download?.state === 'in_progress'" class="button button--secondary" type="button" @click="cancel">
            {{ t('cancel') }}
          </button>
          <button v-else-if="download?.state === 'complete'" class="button button--secondary" type="button" @click="showInFolder">
            {{ t('showInFolder') }}
          </button>
          <button v-else class="button" type="button" :disabled="starting" @click="startDownload">
            {{ t(actionLabel) }}
          </button>
        </template>
        <button class="link" type="button" @click="copyUrl">{{ justCopied ? t('copied') : t('copyUrl') }}</button>
      </div>
    </div>

    <div v-if="download?.state === 'in_progress'" class="progress">
      <div
        class="progress__track"
        role="progressbar"
        :aria-valuenow="progressPercent ?? undefined"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="progressLabel"
      >
        <div class="progress__bar" :class="{ 'progress__bar--indeterminate': progressPercent === null }" :style="{ width: `${progressPercent ?? 30}%` }" />
      </div>
      <span class="progress__label">{{ progressLabel }}<template v-if="progressPercent !== null"> · {{ progressPercent }}%</template></span>
    </div>

    <span v-if="download?.state === 'complete'" class="item__ok">{{ t('downloadComplete') }}</span>
    <span v-if="isProtected" class="item__note">{{ t('drmExplanation') }}</span>
    <span v-else-if="!canDownload" class="item__hint">{{ t('needsCompanion') }}</span>
    <span v-if="errorMessage" class="item__note" role="alert">{{ errorMessage }}</span>
  </li>
</template>
