import http from 'node:http';

const VIDEO_BYTES = Buffer.alloc(2 * 1024 * 1024, 1);

const PAGE = `<!doctype html><title>Aula de teste</title>
<video src="/videos/minha%20aula.mp4" preload="auto" muted></video>
<video src="/hotlink/protegido.mp4" preload="auto" muted></video>
<script>
  fetch('/curso/aula-01/master.m3u8').then(() => fetch('/curso/aula-01/720p/index.m3u8?sig=1'));
  fetch('/drm/index.m3u8');
  fetch('/curso/aula-01/720p/segment-1.m4s');
</script>`;

const FEATURES_PAGE = `<!doctype html><meta charset="utf-8"><title>Recursos da Sprint 4</title>
<script>
  fetch('/live/index.m3u8');
  fetch('/sneaky/master.m3u8').then(() => fetch('/sneaky/v/index.m3u8'));
  fetch('/multi/master.m3u8');
  fetch('/legendas/pt-BR.vtt');
  fetch('/subs-seg/pt/fileSequence1.vtt');
</script>`;

const HLS = 'application/vnd.apple.mpegurl';
const VOD_MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n';

const ROUTES = {
  '/features.html': () => ['text/html; charset=utf-8', FEATURES_PAGE],
  // No #EXT-X-ENDLIST: a live stream.
  '/live/index.m3u8': () => [HLS, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:6,\ns10.ts\n'],
  // Clear master, encrypted variant: must still be treated as protected.
  '/sneaky/master.m3u8': () => [HLS, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nv/index.m3u8\n'],
  '/sneaky/v/index.m3u8': () => [HLS, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k"\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n'],
  '/multi/master.m3u8': () => [
    HLS,
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Português",LANGUAGE="pt-BR",URI="subs/pt.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="s"\n1080/index.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,SUBTITLES="s"\n720/index.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,SUBTITLES="s"\n360/index.m3u8\n',
  ],
  '/multi/1080/index.m3u8': () => [HLS, VOD_MEDIA],
  '/legendas/pt-BR.vtt': () => ['text/vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>Olá</i>, turma\n'],
  '/subs-seg/pt/fileSequence1.vtt': () => ['text/vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsegmento\n'],

  '/page.html': () => ['text/html', PAGE],
  '/empty.html': () => ['text/html', '<p>vazio</p>'],
  '/videos/minha%20aula.mp4': () => ['video/mp4', VIDEO_BYTES],
  // Hotlink protection: only requests carrying the page as Referer are served.
  '/hotlink/protegido.mp4': req => (req.headers.referer ? ['video/mp4', VIDEO_BYTES] : null),
  '/curso/aula-01/master.m3u8': () => ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2800000\n720p/index.m3u8\n'],
  '/curso/aula-01/720p/index.m3u8': () => ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXTINF:6,\nsegment-1.m4s\n#EXT-X-ENDLIST\n'],
  '/curso/aula-01/720p/segment-1.m4s': () => ['video/mp4', Buffer.alloc(1000)],
  '/drm/index.m3u8': () => [
    'application/vnd.apple.mpegurl',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\na.ts\n',
  ],
};

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const route = ROUTES[req.url.split('?')[0]];
    const result = route?.(req);
    if (!result) {
      res.writeHead(route ? 403 : 404);
      return res.end();
    }
    const [contentType, body] = result;
    res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
