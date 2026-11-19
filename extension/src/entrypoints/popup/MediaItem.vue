<script setup lang="ts">
import { computed, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { DetectedMedia } from '@/core/media-classifier';
import type { DownloadRequest, DownloadResponse } from '@/core/messages';
import { displayName, formatBytes } from '@/core/format';
import { toTransferView, primaryAction, type BrowserDownloadStatus, type PrimaryAction } from '@/core/transfer-view';
import { t, TRANSFER_ERROR_MESSAGE, REFUSAL_MESSAGE, type MessageKey } from '@/core/i18n';
import { qualityOptions, defaultOption, type QualityOption } from '@/core/quality';
import type { Preset } from '@/core/settings';

const props = defineProps<{
  media: DetectedMedia;
  tabId: number;
  browserStatus?: BrowserDownloadStatus;
  companionReady: boolean;
  defaultPreset: Preset;
}>();

const KIND_LABEL: Record<DetectedMedia['kind'], MessageKey> = {
  progressive: 'kindProgressive',
  hls: 'kindHls',
  dash: 'kindDash',
  subtitle: 'kindSubtitle',
};
const PROTECTION_LABEL: Record<DetectedMedia['protection'], MessageKey> = {
  clear: 'protectionClear',
  protected: 'protectionProtected',
  unknown: 'protectionUnknown',
};
const ACTION_LABEL: Record<Exclude<PrimaryAction, 'none'>, MessageKey> = {
  download: 'download',
  downloadWithApp: 'downloadWithApp',
  retry: 'retry',
  downloadAgain: 'downloadAgain',
  cancel: 'cancel',
  showInFolder: 'showInFolder',
};

const locale = navigator.language;
const name = computed(() => displayName(props.media.url));
const host = computed(() => new URL(props.media.url).host);
const isProtected = computed(() => props.media.protection === 'protected');
const isStream = computed(() => props.media.kind === 'hls' || props.media.kind === 'dash');
const heights = computed(() => props.media.heights ?? []);
const options = computed(() => qualityOptions(heights.value));
const selectedQuality = ref(defaultOption(heights.value, props.defaultPreset).value);
const showQualityPicker = computed(
  () => isStream.value && props.companionReady && !props.media.live && props.media.protection === 'clear' && action.value === 'download',
);

function optionLabel(option: QualityOption): string {
  const top = heights.value[0];
  if (option.choice.mode === 'best') return top ? t('qualityBestOf', String(top)) : t('qualityBest');
  if (option.choice.mode === 'maxHeight') return t('qualityHeight', String(option.choice.height));
  return t('qualityAudio');
}
const view = computed(() => toTransferView(props.media, props.browserStatus));
const action = computed(() => primaryAction(props.media, view.value, props.companionReady));
const isActive = computed(() => view.value.state === 'queued' || view.value.state === 'running');
const size = computed(() => formatBytes(view.value.totalBytes ?? props.media.sizeBytes, locale));
const refusal = ref<MessageKey | null>(null);
const busy = ref(false);
const justCopied = ref(false);

const progressPercent = computed(() => {
  const { receivedBytes, totalBytes } = view.value;
  return receivedBytes !== undefined && totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null;
});

const progressLabel = computed(() => {
  const { state, receivedBytes, totalBytes, speed } = view.value;
  if (state === 'queued') return t('queued');
  const received = formatBytes(receivedBytes || 1, locale);
  const amount = totalBytes ? t('progressOf', [received, formatBytes(totalBytes, locale)]) : t('progressReceived', received);
  return speed ? `${amount} · ${t('speed', formatBytes(speed, locale))}` : amount;
});

const errorMessage = computed(() => {
  if (refusal.value) return t(refusal.value);
  return view.value.state === 'failed' && view.value.error ? t(TRANSFER_ERROR_MESSAGE[view.value.error]) : '';
});

const showCompanionHint = computed(
  () => isStream.value && !isProtected.value && !props.media.live && !props.companionReady && view.value.state === 'idle',
);

async function runAction() {
  refusal.value = null;
  busy.value = true;
  try {
    switch (action.value) {
      case 'cancel':
        if (view.value.via === 'browser') await browser.downloads.cancel(props.media.downloadId!);
        else await browser.runtime.sendMessage({ type: 'cancel', tabId: props.tabId, mediaKey: props.media.key });
        break;
      case 'showInFolder':
        if (view.value.via === 'browser') browser.downloads.show(props.media.downloadId!);
        else await browser.runtime.sendMessage({ type: 'reveal', tabId: props.tabId, mediaKey: props.media.key });
        break;
      case 'downloadWithApp':
        await requestDownload('companion');
        break;
      default:
        // A retry goes through the same route as the failed attempt.
        await requestDownload(view.value.via === 'companion' ? 'companion' : undefined);
    }
  } finally {
    busy.value = false;
  }
}

async function requestDownload(via?: 'companion') {
  const quality = isStream.value ? options.value.find(o => o.value === selectedQuality.value)?.choice : undefined;
  const request: DownloadRequest = { type: 'download', tabId: props.tabId, mediaKey: props.media.key, ...(via && { via }), ...(quality && { quality }) };
  const response = (await browser.runtime.sendMessage(request)) as DownloadResponse | undefined;
  if (!response?.ok) refusal.value = REFUSAL_MESSAGE[response?.reason ?? 'failed'];
}

async function copyUrl() {
  await navigator.clipboard.writeText(props.media.url);
  justCopied.value = true;
  setTimeout(() => (justCopied.value = false), 1500);
}
</script>

<template>
  <li class="item" :class="{ 'item--protected': isProtected }">
    <div class="item__row">
      <div class="item__main">
        <span class="item__name" :title="media.url">{{ name }}</span>
        <span class="item__meta">
          <span class="tag">{{ t(KIND_LABEL[media.kind]) }}</span>
          <span v-if="media.live" class="tag tag--live">{{ t('live') }}</span>
          <span class="tag" :class="`tag--${media.protection}`">{{ t(PROTECTION_LABEL[media.protection]) }}</span>
          <span>{{ host }}</span>
          <span v-if="size">· {{ size }}</span>
        </span>
      </div>

      <div v-if="!isProtected" class="item__actions">
        <select v-if="showQualityPicker" v-model="selectedQuality" class="select" :aria-label="t('qualityLabel')">
          <option v-for="option in options" :key="option.value" :value="option.value">{{ optionLabel(option) }}</option>
        </select>
        <button
          v-if="action !== 'none'"
          class="button"
          :class="{ 'button--secondary': action === 'cancel' || action === 'showInFolder' }"
          type="button"
          :disabled="busy"
          @click="runAction"
        >
          {{ t(ACTION_LABEL[action as Exclude<PrimaryAction, 'none'>]) }}
        </button>
        <button class="link" type="button" @click="copyUrl">{{ justCopied ? t('copied') : t('copyUrl') }}</button>
      </div>
    </div>

    <div v-if="isActive" class="progress">
      <div
        class="progress__track"
        role="progressbar"
        :aria-valuenow="progressPercent ?? undefined"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="progressLabel"
      >
        <div
          class="progress__bar"
          :class="{ 'progress__bar--indeterminate': progressPercent === null }"
          :style="{ width: `${progressPercent ?? 30}%` }"
        />
      </div>
      <span class="progress__label">{{ progressLabel }}<template v-if="progressPercent !== null"> · {{ progressPercent }}%</template></span>
    </div>

    <span v-if="view.state === 'done'" class="item__ok">{{ t('downloadComplete') }}<template v-if="media.job?.fileName"> · {{ media.job.fileName }}</template></span>
    <span v-if="media.subtitleLanguages?.length" class="item__hint">{{ t('subtitleTracks', media.subtitleLanguages.join(', ')) }}</span>
    <span v-if="isProtected" class="item__note">{{ t('drmExplanation') }}</span>
    <span v-else-if="media.live" class="item__hint">{{ t('liveNotSupported') }}</span>
    <span v-else-if="showCompanionHint" class="item__hint">{{ t('needsCompanion') }}</span>
    <span v-if="errorMessage" class="item__note" role="alert">{{ errorMessage }}</span>
  </li>
</template>
