import { describe, it, expect } from 'vitest';
import { inspectManifest, combineWithVariant, type ManifestInspection } from './manifest-inspector';

const HLS_MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Português",LANGUAGE="pt-BR",URI="subs/pt.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,SUBTITLES="subs"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://other-cdn.example.com/1080p/index.m3u8?sig=x
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=1280x720
720p-alt/index.m3u8
`;

const HLS_MEDIA_VOD = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;

const HLS_MEDIA_LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1042
#EXTINF:6.0,
seg1042.ts
`;

const url = 'https://cdn.example.com/v/master.m3u8';

describe('inspectManifest (HLS protection)', () => {
  it('treats playlists without keys as clear', () => {
    expect(inspectManifest('hls', HLS_MEDIA_VOD, url).protection).toBe('clear');
  });

  it('treats explicit METHOD=NONE as clear', () => {
    expect(inspectManifest('hls', '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST', url).protection).toBe('clear');
  });

  it.each([
    ['SAMPLE-AES (FairPlay)', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"'],
    ['AES-128', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k"'],
    ['session key in master', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="data:..."'],
  ])('flags %s as protected', (_label, keyLine) => {
    expect(inspectManifest('hls', `#EXTM3U\n${keyLine}\n#EXTINF:6,\na.ts`, url).protection).toBe('protected');
  });
});

describe('inspectManifest (HLS structure)', () => {
  const master = inspectManifest('hls', HLS_MASTER, url);

  it('resolves variant playlists first, then audio/subtitle renditions', () => {
    expect(master.variantUrls).toEqual([
      'https://cdn.example.com/v/360p/index.m3u8',
      'https://other-cdn.example.com/1080p/index.m3u8?sig=x',
      'https://cdn.example.com/v/720p/index.m3u8',
      'https://cdn.example.com/v/720p-alt/index.m3u8',
      'https://cdn.example.com/v/subs/pt.m3u8',
      'https://cdn.example.com/v/subs/en.m3u8',
      'https://cdn.example.com/v/audio.m3u8',
    ]);
  });

  it('lists distinct heights, highest first', () => {
    expect(master.heights).toEqual([1080, 720, 360]);
  });

  it('keeps each variant height in playlist order (how ffmpeg numbers variants)', () => {
    expect(master.variantHeights).toEqual([360, 1080, 720, 720]);
  });

  it('lists subtitle languages but not audio renditions', () => {
    expect(master.subtitleLanguages).toEqual(['pt-BR', 'en']);
  });

  it('cannot tell liveness from a master playlist', () => {
    expect(master.live).toBeNull();
  });

  it('detects live and finished media playlists', () => {
    expect(inspectManifest('hls', HLS_MEDIA_VOD, url).live).toBe(false);
    expect(inspectManifest('hls', HLS_MEDIA_LIVE, url).live).toBe(true);
    expect(inspectManifest('hls', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\na.ts', url).live).toBe(false);
  });

  it('reports no variants for a media playlist', () => {
    expect(inspectManifest('hls', HLS_MEDIA_VOD, url)).toMatchObject({ variantUrls: [], heights: [] });
  });
});

describe('combineWithVariant', () => {
  const master = inspectManifest('hls', HLS_MASTER, url);

  it('takes liveness from the variant', () => {
    expect(combineWithVariant(master, inspectManifest('hls', HLS_MEDIA_LIVE, url))?.live).toBe(true);
  });

  it('marks the stream protected when only the variant is encrypted', () => {
    const encrypted = inspectManifest('hls', `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST`, url);
    expect(combineWithVariant(master, encrypted)).toMatchObject({ protection: 'protected', heights: [1080, 720, 360] });
  });

  it('stays undecided when the variant cannot be read', () => {
    expect(combineWithVariant(master, null)).toBeNull();
  });

  it('returns media playlists unchanged', () => {
    const media: ManifestInspection = inspectManifest('hls', HLS_MEDIA_VOD, url);
    expect(combineWithVariant(media, null)).toBe(media);
  });
});

describe('inspectManifest (DASH)', () => {
  const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT60S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="1" bandwidth="5000000" width="1920" height="1080"/>
      <Representation id="2" bandwidth="1000000" width="854" height="480"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="pt"><Representation id="a" bandwidth="128000"/></AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="pt-BR"><Representation id="s" bandwidth="1000"/></AdaptationSet>
  </Period>
</MPD>`;

  it('lists heights and text tracks', () => {
    expect(inspectManifest('dash', MPD, 'https://c.example.com/m.mpd')).toMatchObject({
      protection: 'clear',
      heights: [1080, 480],
      live: false,
      subtitleLanguages: ['pt-BR'],
    });
  });

  it('detects live (dynamic) presentations', () => {
    expect(inspectManifest('dash', MPD.replace('type="static"', 'type="dynamic"'), 'https://c.example.com/m.mpd').live).toBe(true);
  });

  it('flags ContentProtection (Widevine/PlayReady) as protected', () => {
    const body = '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period></MPD>';
    expect(inspectManifest('dash', body, 'https://c.example.com/m.mpd').protection).toBe('protected');
  });
});
