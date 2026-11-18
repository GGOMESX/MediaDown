import { describe, it, expect } from 'vitest';
import { inspectManifest } from './manifest-inspector';

const HLS_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
https://other-cdn.example.com/720p/index.m3u8?sig=x
`;

const HLS_MEDIA_CLEAR = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;

describe('inspectManifest (HLS)', () => {
  it('treats playlists without keys as clear', () => {
    expect(inspectManifest('hls', HLS_MEDIA_CLEAR, 'https://cdn.example.com/v/index.m3u8').protection).toBe('clear');
  });

  it('treats explicit METHOD=NONE as clear', () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.ts';
    expect(inspectManifest('hls', body, 'https://c.example.com/x.m3u8').protection).toBe('clear');
  });

  it.each([
    ['SAMPLE-AES (FairPlay)', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"'],
    ['AES-128', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k"'],
    ['session key in master', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="data:..."'],
  ])('flags %s as protected', (_label, keyLine) => {
    const body = `#EXTM3U\n${keyLine}\n#EXTINF:6,\na.ts`;
    expect(inspectManifest('hls', body, 'https://c.example.com/x.m3u8').protection).toBe('protected');
  });

  it('resolves variant playlist URLs of a master playlist', () => {
    const result = inspectManifest('hls', HLS_MASTER, 'https://cdn.example.com/v/master.m3u8');
    expect(result.variantUrls).toEqual([
      'https://cdn.example.com/v/360p/index.m3u8',
      'https://other-cdn.example.com/720p/index.m3u8?sig=x',
    ]);
  });

  it('reports no variants for a media playlist', () => {
    expect(inspectManifest('hls', HLS_MEDIA_CLEAR, 'https://c.example.com/x.m3u8').variantUrls).toEqual([]);
  });
});

describe('inspectManifest (DASH)', () => {
  it('flags ContentProtection (Widevine/PlayReady) as protected', () => {
    const body = '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period></MPD>';
    expect(inspectManifest('dash', body, 'https://c.example.com/m.mpd').protection).toBe('protected');
  });

  it('treats MPDs without ContentProtection as clear', () => {
    const body = '<MPD><Period><AdaptationSet mimeType="video/mp4"></AdaptationSet></Period></MPD>';
    expect(inspectManifest('dash', body, 'https://c.example.com/m.mpd').protection).toBe('clear');
  });
});
