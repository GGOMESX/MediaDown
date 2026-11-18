import type { ObservedResponse } from './media-classifier';

export interface HttpHeader {
  name: string;
  value?: string;
}

export function toObservedResponse(url: string, headers: readonly HttpHeader[] | undefined): ObservedResponse {
  const contentType = headerValue(headers, 'content-type');
  const contentLength = totalFromContentRange(headerValue(headers, 'content-range')) ?? parseSize(headerValue(headers, 'content-length'));

  return {
    url,
    ...(contentType !== undefined && { contentType }),
    ...(contentLength !== undefined && { contentLength }),
  };
}

function headerValue(headers: readonly HttpHeader[] | undefined, name: string): string | undefined {
  return headers?.find(header => header.name.toLowerCase() === name)?.value;
}

// A 206 response's content-length is only the chunk; the full size is after the slash.
function totalFromContentRange(value: string | undefined): number | undefined {
  const total = value?.match(/\/(\d+)\s*$/)?.[1];
  return parseSize(total);
}

function parseSize(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const size = Number(value);
  return size > 0 ? size : undefined;
}
