import type { DetectedMedia } from './media-classifier';

export type CompanionError =
  | 'invalidRequest' | 'engineMissing' | 'forbidden' | 'expired' | 'network' | 'diskFull' | 'drm' | 'canceled' | 'unknown'
  | 'disconnected';

export interface CompanionJob {
  id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number;
  etaSeconds?: number;
  fileName?: string;
  error?: CompanionError;
}

export type HostEvent =
  | { type: 'hello'; protocolVersion: number; hostVersion: string; engineReady: boolean; engineVersion?: string | null }
  | { type: 'queued' | 'started'; jobId: string }
  | { type: 'progress'; jobId: string; downloadedBytes?: number | null; totalBytes?: number | null; speed?: number | null; etaSeconds?: number | null }
  | { type: 'done'; jobId: string; fileName: string }
  | { type: 'failed'; jobId: string; error: CompanionError; detail: string }
  | { type: 'invalidRequest'; detail: string };

const JOB_EVENT_TYPES = new Set(['queued', 'started', 'progress', 'done', 'failed']);
const KNOWN_ERRORS = new Set<CompanionError>(['invalidRequest', 'engineMissing', 'forbidden', 'expired', 'network', 'diskFull', 'drm', 'canceled', 'unknown']);

/** The tab id is encoded in the job id, so host events can be routed without extra state. */
export function newJobId(tabId: number, random: string = crypto.randomUUID()): string {
  return `t${tabId}-${random.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
}

export function tabIdFromJobId(jobId: string): number | null {
  const match = jobId.match(/^t(\d+)-[a-zA-Z0-9]+$/);
  return match ? Number(match[1]) : null;
}

/** The host is a separate program: check the shape of what it sends before using it. */
export function parseHostEvent(raw: unknown): HostEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as Record<string, unknown>;
  if (event.type === 'hello') return typeof event.protocolVersion === 'number' ? (event as HostEvent) : null;
  if (event.type === 'invalidRequest') return event as HostEvent;
  if (typeof event.type !== 'string' || !JOB_EVENT_TYPES.has(event.type) || typeof event.jobId !== 'string') return null;
  if (event.type === 'failed' && !KNOWN_ERRORS.has(event.error as CompanionError)) return { ...(event as HostEvent), error: 'unknown' } as HostEvent;
  return event as HostEvent;
}

export function applyJobStarted(list: readonly DetectedMedia[], key: string, jobId: string): DetectedMedia[] {
  return list.map(item => (item.key === key ? { ...item, downloadId: undefined, job: { id: jobId, state: 'queued' } } : item));
}

export function applyHostEvent(list: readonly DetectedMedia[], event: HostEvent): DetectedMedia[] {
  if (!('jobId' in event)) return [...list];
  return list.map(item => (item.job?.id === event.jobId ? { ...item, job: nextJob(item.job, event) } : item));
}

export function failActiveJobs(list: readonly DetectedMedia[], error: CompanionError): DetectedMedia[] {
  return list.map(item => (isActive(item.job) ? { ...item, job: { ...item.job!, state: 'failed', error } } : item));
}

export function isActive(job: CompanionJob | undefined): boolean {
  return job?.state === 'queued' || job?.state === 'running';
}

function nextJob(job: CompanionJob, event: HostEvent): CompanionJob {
  switch (event.type) {
    case 'queued':
      return job;
    case 'started':
      return { ...job, state: 'running' };
    case 'progress':
      return {
        ...job,
        state: 'running',
        downloadedBytes: event.downloadedBytes ?? job.downloadedBytes,
        totalBytes: event.totalBytes ?? job.totalBytes,
        speed: event.speed ?? undefined,
        etaSeconds: event.etaSeconds ?? undefined,
      };
    case 'done':
      return { ...job, state: 'done', fileName: event.fileName, speed: undefined, etaSeconds: undefined };
    case 'failed':
      return { ...job, state: 'failed', error: event.error, speed: undefined, etaSeconds: undefined };
    default:
      return job;
  }
}
