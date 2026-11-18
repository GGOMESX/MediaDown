# Media Downloader

Extensão de navegador + app desktop (companion) para detectar e baixar vídeos
**sem proteção** (sem DRM). Uso pessoal.

| Pasta | Conteúdo | Status |
|---|---|---|
| `extension/` | Extensão MV3 (WXT + TypeScript + Vue) | Sprint 1 ✅ |
| `companion/` | App Tauri que executa yt-dlp/ffmpeg | Sprint 3 |

## Extensão: desenvolvimento

```bash
cd extension
npm install
npm test          # testes unitários (Vitest)
npm run typecheck
npm run dev       # abre um Chrome com a extensão carregada e hot reload
npm run build     # gera .output/chrome-mv3
```

### Instalar no seu navegador (sem loja)

- **Chrome/Edge/Brave:** `chrome://extensions` → ativar *Modo do desenvolvedor* →
  *Carregar sem compactação* → selecionar `extension/.output/chrome-mv3`.
- **Firefox:** `npm run build:firefox` → `about:debugging#/runtime/this-firefox` →
  *Carregar extensão temporária* → selecionar `extension/.output/firefox-mv2/manifest.json`.

## Como funciona (Sprint 1)

1. O service worker observa respostas de rede (`webRequest.onHeadersReceived`) e
   classifica arquivos de vídeo, playlists HLS (`.m3u8`) e manifestos DASH (`.mpd`).
   Segmentos (`.m4s`, `.ts`, `segment-N`) são ignorados.
2. Playlists e manifestos são baixados uma vez para verificar criptografia.
   **Qualquer** criptografia (DRM, SAMPLE-AES, AES-128, `ContentProtection`) marca a
   mídia como protegida, e ela nunca será baixada.
3. Variantes de uma playlist master ficam ocultas atrás da master.
4. A lista fica em `storage.session` por aba e é limpa ao navegar ou fechar a aba.
   O ícone mostra a contagem.

## Decisões registradas

- `host_permissions: <all_urls>` é obrigatório nesta build pessoal: a mídia
  normalmente vem de uma CDN em outro domínio, e o `webRequest` só enxerga hosts
  permitidos. Uma build para loja precisaria de permissão opcional pedida no popup.
- Nenhum servidor: tudo roda localmente.
