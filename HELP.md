# claude-statusline — O que significa cada segmento

Esta página é aberta quando você Cmd/Ctrl+clica no `(?)` ao final da status line. Também acessível via `claude-statusline explain`.

---

## Linha 1 — Contexto

```
╭─  ~/code/projeto/src · ⎇ main +3 ~2 · 󰚩 Opus 4.7 · high
```

### `~/code/projeto/src`
Diretório de trabalho atual. Se o caminho for muito profundo, fica `~/…/projeto/src` (mostra só os 2 últimos segmentos).

### `⎇ main +3 ~2`
Estado do git:
- **`main`** — branch atual (ou hash curto se HEAD detached)
- **`↑N`** / **`↓N`** — commits ahead/behind do upstream
- **`+N`** — arquivos novos / staged add
- **`~N`** — arquivos modificados
- **`−N`** — arquivos deletados

**Cor**: verde = limpo (sem mudanças), âmbar = dirty.

### `󰚩 Opus 4.7`
Modelo do Claude ativo na sessão. Mostra display name compacto.

### `high` / `med` / `low`
Effort level configurado (campo `effortLevel` no `settings.json`). Só aparece se setado.

### `wt:feature-x`
Indicador de worktree. Só aparece se você estiver dentro de um worktree do Claude Code.

---

## Linha 2 — Métricas

```
╰─  $0.42 ·  219.4k ctx · last +187 ·  18m03s ·  ███████░░░ 73%  +156/-23 · 🟢 5h · resets in 2h14m · 🔥 hot 1.5×
```

### ` $0.42`
Custo total em USD dessa sessão (vem do campo `cost.total_cost_usd` do Claude Code).

### ` 219.4k ctx · last +187` — tamanho do contexto / output do último turno

Aqui tem uma sutileza importante. O Claude Code **não fornece contadores acumulados** de tokens da sessão — os campos `context_window` são **snapshots do turno atual**. Então o statusline mostra o que dá pra mostrar de forma honesta:

- **`219.4k ctx`** — o tamanho do contexto **agora**: system prompt do Claude Code + definições de ferramentas + CLAUDE.md + todo o histórico da conversa. É o número que importa — "quão cheio está o contexto". Por isso até um "oi" já mostra `~8k ctx`: esse overhead é real, é o custo fixo de qualquer sessão.
- **`last +187`** — output **só do último turno** (`total_output_tokens`). Muda a cada resposta. É labelado "last" de propósito, pra você não confundir com um total de sessão (que o Claude Code simplesmente não expõe).

**Por que não tem "total de tokens da sessão" ou "tokens da minha conversa"?** Porque o Claude Code não fornece esses dados. Os campos são snapshots por turno, não acumulados. O statusline mostra `ctx` (útil) e `last` (honesto sobre o que é) em vez de inventar um "total" que seria mentira.

### ` 18m03s`
Wall-clock da sessão. Quanto tempo passou desde que você abriu o Claude Code.

### ` ███████░░░ 73%`
**Context window**: quanto do contexto da sessão já está cheio. Quando passa de 100% o Claude precisa fazer compaction.

**Cor**:
- 🟢 **verde** (< 50%) — bem livre
- 🟡 **âmbar** (50–79%) — preparando o terreno pra compaction
- 🔴 **vermelho** (≥ 80%) — vai compactar em breve

### `+156/-23`
Linhas de código adicionadas e removidas nessa sessão. Só aparece quando você editou algo.

### `🟢 5h · resets in 2h14m`
**Rate limit de 5 horas do seu plano**:
- **Bolinha colorida** — reflete o **pace** (veja abaixo), não a % bruta de uso
- **`resets in Xh YYm`** — tempo até a janela de 5h zerar

### `🔥 hot 1.5×` — o indicador de **pace**

Esse é o segmento mais importante pra você entender. Ele responde: **"estou gastando rápido demais?"**

```
pace = uso_atual ÷ tempo_decorrido     (ambos como fração da janela de 5h)
```

O número que aparece é um **multiplicador**:

| Pace | Tradução |
|---|---|
| **1.0×** | Ritmo perfeito — você vai bater 100% de uso exatamente no momento do reset |
| **< 1.0×** | Tem folga — está gastando mais devagar que o tempo passa (ex: 0.5× = metade do ritmo) |
| **> 1.0×** | Acelerado — nesse ritmo você bate o teto antes do reset (ex: 2.0× = queimando o dobro) |

**Buckets:**

| Pace | Ícone | Cor | Significado |
|---|---|---|---|
| < 0.7× | 🐢 chill | 🟢 verde | Bastante folga, pode gastar à vontade |
| 0.7–0.99× | 🚶 ok | 🟢 verde | Exatamente no ritmo |
| 1.0–1.29× | 🏃 fast | 🟡 âmbar | Acelerado, segura um pouco |
| ≥ 1.3× | 🔥 hot | 🔴 vermelho | Muito acima, vai bater o teto cedo |

**Exemplo 1:** você usou 30% do limite em 1h da janela de 5h. Pace = `0.30 ÷ 0.20 = 1.5×` → `🔥 hot 1.5×`. Tradução: nesse ritmo bate 100% em ~3h20, segura.

**Exemplo 2:** usou 60% em 4h. Pace = `0.60 ÷ 0.80 = 0.75×` → `🐢 chill 0.8×`. Tradução: tem orçamento sobrando pra última hora.

**Nota:** nos primeiros 2% da janela (~6min), o pace fica oculto pra evitar números doidos (3000%, 12000%) que não são úteis.

---

## Update

Se você está vendo o badge **`⬆ vX.Y.Z available`** no fim da status line, significa que tem uma versão nova publicada no GitHub que ainda não foi baixada na sua máquina.

**Para instalar agora**, rode no terminal:

```bash
claude-statusline update
```

Pronto. O badge some na próxima atualização da status line (~5s).

**Como funciona o auto-update normalmente?** A status line verifica o GitHub uma vez por dia em background. Quando você vê o badge, é porque já houve uma checagem e foi detectada uma versão nova — mas o download em background pode ainda não ter acontecido ou ter falhado por motivos de rede. O comando `update` força a baixar imediatamente.

**Para esconder o badge:**
```bash
export CLAUDE_STATUSLINE_NO_UPDATE_BADGE=1
```

---

## Comandos úteis

| Comando | O que faz |
|---|---|
| `claude-statusline status` | Mostra versão local, última checagem, e se tem update |
| `claude-statusline update` | Força download da versão mais recente agora |
| `claude-statusline explain` | Mostra essa explicação no terminal |
| `claude-statusline uninstall` | Remove tudo |

---

## Voltar ao README

Para instalação, customização e troubleshooting, veja o [README](./README.md).
