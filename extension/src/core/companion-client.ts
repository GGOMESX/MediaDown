import { browser, type Browser } from 'wxt/browser';
import { parseHostEvent, tabIdFromJobId, applyHostEvent, failActiveJobs, type HostEvent } from './companion-job';
import { updateTabMedia, readAllTabIds } from './tab-media-store';
import type { CompanionStatus } from './messages';
import type { QualityChoice } from './quality';
import { completePending, dropPending, pendingIdForJob } from './history';

export const NATIVE_HOST_NAME = 'com.mediadown.host';
const PROTOCOL_VERSION = 3;
// The first yt-dlp start on Windows unpacks itself and can take a few seconds.
const HELLO_TIMEOUT_MS = 20_000;
const IDLE_DISCONNECT_MS = 15_000;
const PROGRESS_WRITE_INTERVAL_MS = 300;

export type HostRequest =
  | {
      type: 'download';
      jobId: string;
      url: string;
      referer?: string;
      userAgent?: string;
      folder: string;
      fileName: string;
      quality: QualityChoice;
      subtitles: boolean;
    }
  | { type: 'record'; jobId: string; url: string; referer?: string; userAgent?: string; folder: string; fileName: string }
  | { type: 'stop' | 'cancel' | 'reveal'; jobId: string };

/** What download-service needs from the companion; tests swap in a fake. */
export interface CompanionGateway {
  status(): Promise<CompanionStatus>;
  send(request: HostRequest): Promise<void>;
}

class CompanionConnection implements CompanionGateway {
  private port: Browser.runtime.Port | null = null;
  private hello: Promise<CompanionStatus> | null = null;
  private readonly activeJobs = new Set<string>();
  private readonly lastProgressWrite = new Map<string, number>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  status(): Promise<CompanionStatus> {
    const status = this.connect();
    void status.then(() => this.scheduleIdleDisconnect());
    return status;
  }

  async send(request: HostRequest): Promise<void> {
    const status = await this.connect();
    if (status.state !== 'ready' || !this.port) throw new Error(`companion ${status.state}`);
    if (request.type === 'download' || request.type === 'record') this.activeJobs.add(request.jobId);
    clearTimeout(this.idleTimer);
    this.port.postMessage(request);
  }

  private connect(): Promise<CompanionStatus> {
    if (this.hello) return this.hello;

    this.hello = new Promise<CompanionStatus>(resolve => {
      let settled = false;
      const settle = (status: CompanionStatus) => {
        if (!settled) {
          settled = true;
          resolve(status);
        }
      };
      const timeout = setTimeout(() => {
        // A host that never answers must not stay cached as the connection: retry next time.
        this.port?.disconnect();
        this.port = null;
        this.hello = null;
        settle({ state: 'incompatible' });
      }, HELLO_TIMEOUT_MS);

      let port: Browser.runtime.Port;
      try {
        port = browser.runtime.connectNative(NATIVE_HOST_NAME);
      } catch {
        clearTimeout(timeout);
        this.hello = null;
        return settle({ state: 'notInstalled' });
      }
      this.port = port;

      port.onMessage.addListener(raw => {
        const event = parseHostEvent(raw);
        if (!event) return;
        if (event.type === 'hello') {
          clearTimeout(timeout);
          settle(toStatus(event));
        } else {
          void this.handleJobEvent(event);
        }
      });

      port.onDisconnect.addListener(() => {
        const reason = browser.runtime.lastError?.message ?? '';
        clearTimeout(timeout);
        this.port = null;
        this.hello = null;
        settle({ state: /not found|not exist|forbidden/i.test(reason) ? 'notInstalled' : 'incompatible' });
        void this.failAll();
      });

      port.postMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    });
    return this.hello;
  }

  private async handleJobEvent(event: HostEvent) {
    if (!('jobId' in event)) return;
    const tabId = tabIdFromJobId(event.jobId);
    if (tabId === null) return;

    if (event.type === 'progress') {
      // yt-dlp reports many times per second; storage writes are not free.
      const now = Date.now();
      if (now - (this.lastProgressWrite.get(event.jobId) ?? 0) < PROGRESS_WRITE_INTERVAL_MS) return;
      this.lastProgressWrite.set(event.jobId, now);
    }
    if (event.type === 'done' || event.type === 'failed') {
      this.activeJobs.delete(event.jobId);
      this.lastProgressWrite.delete(event.jobId);
      // Independent of the tab: it may have navigated away while the app was downloading.
      if (event.type === 'done') void completePending(pendingIdForJob(event.jobId), { fileName: event.fileName });
      else void dropPending(pendingIdForJob(event.jobId));
    }

    try {
      await updateTabMedia(tabId, list => applyHostEvent(list, event));
    } catch {
      // The tab may have been closed meanwhile.
    }
    if (this.activeJobs.size === 0) this.scheduleIdleDisconnect();
  }

  private scheduleIdleDisconnect() {
    clearTimeout(this.idleTimer);
    if (this.activeJobs.size > 0) return;
    // Keep the host alive briefly (the user often starts another download), then let it exit.
    this.idleTimer = setTimeout(() => {
      if (this.activeJobs.size > 0 || !this.port) return;
      this.port.disconnect();
      this.port = null;
      this.hello = null;
    }, IDLE_DISCONNECT_MS);
  }

  private async failAll() {
    this.activeJobs.clear();
    await failStaleJobs();
  }
}

/** Jobs left "running" with no host connection (port dropped, or the service worker restarted). */
export async function failStaleJobs(): Promise<void> {
  const tabIds = await readAllTabIds();
  await Promise.all(tabIds.map(tabId => updateTabMedia(tabId, list => failActiveJobs(list, 'disconnected')).catch(() => undefined)));
}

function toStatus(event: Extract<HostEvent, { type: 'hello' }>): CompanionStatus {
  if (event.protocolVersion !== PROTOCOL_VERSION) return { state: 'incompatible', hostVersion: event.hostVersion };
  return {
    state: event.engineReady ? 'ready' : 'engineMissing',
    hostVersion: event.hostVersion,
    engineVersion: event.engineVersion ?? undefined,
  };
}

export const companion: CompanionGateway = new CompanionConnection();
