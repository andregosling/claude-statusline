# claude-statusline

Status line de duas linhas para o [Claude Code](https://claude.com/code) — denso, colorido, e com tudo que importa numa olhada: path, branch + dirty state, modelo, custo, tokens, duração, uso do context window, linhas alteradas e rate limit do plano com contagem regressiva.

![preview](./screenshot.png)

```
╭─  ~/code/projeto/src · ⎇ main +3 ~2 · 󰚩 Opus 4.7 · high
╰─  $0.42 ·  43.0k tok ·  18m03s ·  ███████░░░ 73%  +156/-23 · 🟢 5h · resets in 2h14m
```

---

## Instalação (1 comando)

```bash
curl -fsSL https://raw.githubusercontent.com/andregosling/claude-statusline/main/install.sh | bash
```

O instalador:

- Baixa o `statusline.sh` para `~/.claude/`
- Baixa o `statusline-loader.sh` (wrapper que faz auto-update)
- Edita seu `~/.claude/settings.json` adicionando a seção `statusLine` (faz backup primeiro)
- Avisa se você não tem uma Nerd Font instalada

Depois é só recarregar o Claude Code.

---

## Auto-update

O status line se atualiza **automaticamente em até 24h** depois de qualquer commit nesse repo, sem você fazer nada.

Como funciona: o `statusline-loader.sh` é chamado pelo Claude Code a cada refresh. Ele roda o renderer local (instantâneo) e, no máximo 1x por dia, dispara um `curl` em background para checar se tem versão nova no GitHub. Se tiver, sobrescreve o arquivo local. Render nunca espera pela rede.

Para forçar update agora:

```bash
rm ~/.claude/cache/claude-statusline/last-check
```

O próximo render vai buscar a versão mais recente.

Para desligar o auto-update e travar na versão atual: edite `~/.claude/settings.json` e troque `statusline-loader.sh` por `statusline.sh` no campo `command`.

---

## Requisitos

- **Claude Code** (obviamente)
- **`jq`** — `brew install jq` (macOS) ou `apt install jq` (Linux)
- **`curl`** — já vem no macOS/Linux
- **Uma Nerd Font** no seu terminal (recomendado: JetBrainsMono Nerd Font)

### Instalar a Nerd Font

**macOS:**
```bash
brew install --cask font-jetbrains-mono-nerd-font
```

**Linux:** baixe de [nerdfonts.com](https://www.nerdfonts.com/font-downloads).

Depois, configure seu terminal (iTerm2 / Terminal.app / Alacritty / WezTerm / etc.) para usar `JetBrainsMono Nerd Font` como fonte. Sem isso os ícones aparecem como quadradinhos vazios (`□`) — o status line continua funcionando, só fica menos bonito.

---

## O que aparece

**Linha 1 (contexto):**

| Segmento | Exemplo | Notas |
|---|---|---|
| Path |  `~/…/projeto/src` | Colapsa para os 2 últimos segmentos quando o caminho é profundo |
| Git | `⎇ main +3 ~2 -1` | Branch + ahead/behind + added/modified/deleted. Verde quando limpo, âmbar quando dirty |
| Modelo | `󰚩 Opus 4.7` | Display name compacto |
| Effort | `high` / `med` / `low` | Só aparece se `effortLevel` estiver setado |
| Worktree | `wt:feature-x` | Só se estiver dentro de um worktree |

**Linha 2 (métricas):**

| Segmento | Exemplo | Notas |
|---|---|---|
| Custo |  `$0.42` | Total da sessão em USD |
| Tokens |  `43.0k tok` | Soma de input + output |
| Duração |  `18m03s` | Tempo de wall-clock da sessão |
| Context |  `███████░░░ 73%` | Verde <50%, âmbar 50-79%, vermelho ≥80% |
| Linhas | `+156/-23` | Só aparece quando você editou algo |
| Rate limit 5h | 🟢 `5h · resets in 2h14m` | Bolinha colorida (verde/âmbar/vermelho) + countdown |

---

## Customização

O `statusline.sh` é um script bash simples. Edita à vontade:

```bash
$EDITOR ~/.claude/statusline.sh
```

**Atenção**: se você editar localmente, o auto-update vai sobrescrever suas mudanças na próxima checagem. Para customizar permanentemente:

1. Faça fork do repo
2. Edite seu fork
3. Mude a URL `REPO_RAW` em `~/.claude/statusline-loader.sh` para apontar pro seu fork

Ou simplesmente desative o auto-update (veja seção acima).

### Variáveis úteis pra mexer

No topo de `statusline.sh`:

- **Cores**: `C_PATH`, `C_GIT`, `C_MODEL`, etc. — RGB truecolor, mude o `38;2;R;G;B`
- **Glyphs**: `G_FOLDER`, `G_BRANCH`, `G_MODEL`, etc. — qualquer caractere/emoji/glyph Nerd Font
- **Thresholds**: a função `ctx_color_for()` controla quando o context bar fica âmbar (50%) e vermelho (80%)
- **Refresh**: edite `refreshInterval` em `~/.claude/settings.json` (segundos)

---

## Desinstalar

```bash
rm ~/.claude/statusline.sh ~/.claude/statusline-loader.sh
rm -rf ~/.claude/cache/claude-statusline
```

E remova manualmente a chave `"statusLine"` do `~/.claude/settings.json`.

---

## Troubleshooting

**Os ícones aparecem como `□` ou `?`** — sua fonte de terminal não é uma Nerd Font. Veja a seção de [Requisitos](#requisitos).

**Não aparece nada** — verifique se o script tem permissão de execução:
```bash
chmod +x ~/.claude/statusline.sh ~/.claude/statusline-loader.sh
```

**Erro "jq: command not found"** — instale o jq: `brew install jq`.

**Atualização não chegou** — force a próxima checagem:
```bash
rm ~/.claude/cache/claude-statusline/last-check
```

**Quero ver o log de updates:**
```bash
cat ~/.claude/cache/claude-statusline/update.log
```

---

## Licença

MIT — veja [LICENSE](./LICENSE).
