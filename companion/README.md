# Companion (Tauri / Rust)

Planejado para a **Sprint 3**: app desktop que recebe pedidos da extensão via
Native Messaging e executa `yt-dlp` + `ffmpeg` localmente.

Regras de segurança já definidas:
- aceitar mensagens apenas do ID da extensão (`allowed_origins`);
- URLs somente `http`/`https`, presets de qualidade em lista fechada;
- processos via argv (nunca shell), com `--` antes da URL;
- nunca usar `--allow-unplayable-formats` nem ler cookies do navegador.
