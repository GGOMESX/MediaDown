import type { DownloadError } from './download-errors';
import type { CompanionError, CompanionJob } from './companion-job';
import type { DetectedMedia } from './media-classifier';

export interface BrowserDownloadStatus {
  state: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes?: number;
  error?: DownloadError;
}

export type TransferError = DownloadError | CompanionError;

export interface TransferView {
  via: 'browser' | 'companion';
  state: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  receivedBytes?: number;
  totalBytes?: number;
  speed?: number;
  error?: TransferError;
}

const IDLE: TransferView = { via: 'browser', state: 'idle' };

/** One shape for the popup, whether the bytes are moved by the browser or by the companion. */
export function toTransferView(media: DetectedMedia, browserStatus: BrowserDownloadStatus | undefined): TransferView {
  if (media.job) return fromJob(media.job);
  if (media.downloadId !== undefined && browserStatus) return fromBrowser(browserStatus);
  return IDLE;
}

export type PrimaryAction = 'download' | 'downloadWithApp' | 'retry' | 'downloadAgain' | 'cancel' | 'showInFolder' | 'none';

export function primaryAction(media: DetectedMedia, view: TransferView, companionReady: boolean): PrimaryAction {
  if (media.protection !== 'clear' || media.live) return 'none';
  switch (view.state) {
    case 'queued':
    case 'running':
      return 'cancel';
    case 'done':
      return 'showInFolder';
    case 'failed':
      // The browser cannot send a Referer; the companion can, so offer it for hotlink failures.
      if (view.via === 'browser' && view.error === 'forbidden' && companionReady) return 'downloadWithApp';
      return view.error === 'network' || view.error === 'unknown' || view.error === 'disconnected' ? 'retry' : 'downloadAgain';
    default:
      return 'download';
  }
}

function fromJob(job: CompanionJob): TransferView {
  return {
    via: 'companion',
    state: job.state,
    receivedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    error: job.error,
  };
}

function fromBrowser(status: BrowserDownloadStatus): TransferView {
  const state = status.state === 'complete' ? 'done' : status.state === 'interrupted' ? 'failed' : 'running';
  return { via: 'browser', state, receivedBytes: status.bytesReceived, totalBytes: status.totalBytes, error: status.error };
}
