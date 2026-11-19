# Media Downloader

Extensão de navegador + app companion para Windows para detectar e baixar vídeos
**sem proteção** (sem DRM). Uso pessoal.

| Pasta | Conteúdo | Status |
|---|---|---|
| `extension/` | Extensão MV3 (WXT + TypeScript + Vue) | Sprints 1–3 ✅ |
| `companion/` | Host nativo em Rust (Windows) que executa yt-dlp/ffmpeg | Sprint 3 ✅ ([detalhes](companion/README.md)) |

## Instalação rápida (Windows)

1. Em **Actions → CI**, abra a execução mais recente com sucesso e baixe os artefatos
   `extension-chrome` e `MediaDown-companion-windows`.
2. **Extensão:** `chrome://extensions` → *Modo do desenvolvedor* → *Carregar sem
   compactação* → pasta `extension-chrome`.
3. **App:** extraia `MediaDown-companion-windows` e dê dois cliques em `install.cmd`.
4. Recarregue a extensão. O rodapé do popup deve mostrar "App MediaDown conectado".

## Extensão: desenvolvimento

```bash
cd extension
npm install
npm test          # testes unitários (Vitest)
npm run test:e2e  # build + testes E2E no Chromium com a extensão carregada (Playwright)
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

## Download direto (Sprint 2)

- Botão **Baixar** para arquivos MP4/WebM sem proteção, com progresso, cancelamento,
  retomada e **Mostrar na pasta**.
- **Opções** (link no popup): subpasta dentro de Downloads e "perguntar onde salvar".
  O navegador não permite gravar fora da pasta Downloads, a menos que o usuário
  escolha o local manualmente.
- Nome do arquivo: vem da URL; se a URL for um hash da CDN, usa o título da página.
  Caracteres inválidos no Windows, nomes reservados (`CON`, `NUL`…) e path traversal
  são neutralizados. Se o sistema recusar acentos, tenta de novo sem eles.
- O background **revalida** cada pedido: só baixa mídia que está na lista da aba,
  sem proteção e progressiva. Uma mensagem forjada não consegue baixar URL
  arbitrária nem conteúdo com DRM, e isso tem teste E2E.
- Sites com proteção contra hotlink (exigem `Referer`) falham no
  download direto, porque a API de downloads não permite definir esse cabeçalho.
  A extensão explica o motivo e oferece o download pelo app companion.

## Download pelo app companion (Sprint 3)

- **HLS e DASH** são baixados pelo app e salvos como MP4 (vídeo e áudio unidos pelo
  ffmpeg). O nome do arquivo vem do título da página.
- **Proteção contra hotlink:** quando o navegador recebe 403, o popup oferece
  **Baixar com o app**, que envia a página como `Referer`.
- **Qualidade** nas opções: melhor qualidade, até 1080p ou somente áudio (MP3).
- Progresso com velocidade, cancelamento e **Mostrar na pasta** (abre o Explorer).
- Se o app não estiver instalado, o popup explica o que fazer, em vez de falhar.

## Decisões registradas

- `host_permissions: <all_urls>` é obrigatório nesta build pessoal: a mídia
  normalmente vem de uma CDN em outro domínio, e o `webRequest` só enxerga hosts
  permitidos. Uma build para loja precisaria de permissão opcional pedida no popup.
- Nenhum servidor: tudo roda localmente.
- O `key` no manifesto fixa o ID da extensão (`jakijlbgipgbbaldfhhpglollgnldckh`), o
  que permite ao app aceitar somente esta extensão. A chave privada não é necessária
  para uso sem empacotar e não fica no repositório.
- O companion é um host nativo em Rust **sem interface própria**, em vez de um app
  Tauri: toda a interface já está no popup, e um binário de ~1,5 MB sem WebView é mais
  simples e seguro. Se um dia for preciso uma janela de fila que sobreviva ao
  navegador fechado, o Tauri pode envolver o mesmo núcleo.
