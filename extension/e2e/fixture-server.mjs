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

const ROUTES = {
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
