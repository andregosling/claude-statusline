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
╰─  $0.42 ·  43.0k tok ·  18m03s ·  ███████░░░ 73%  +156/-23 · 🟢 5h · resets in 2h14m · 🔥 hot 150%
```

### ` $0.42`
Custo total em USD dessa sessão (vem do campo `cost.total_cost_usd` do Claude Code).

### ` 43.0k tok`
Soma de tokens de input + output usados na sessão. Formato `k` (mil) e `M` (milhão).

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

### `🔥 hot 150%` — o indicador de **pace**

Esse é o segmento mais importante pra você entender. Ele responde: **"estou gastando rápido demais?"**

```
pace = uso_atual / tempo_decorrido
```

Ambos são frações de 0–1 da janela de 5h. Significados:

| Pace | Tradução |
|---|---|
| **100%** | Você vai bater 100% de uso exatamente no momento do reset (ritmo perfeito) |
| **< 100%** | Tem folga — está usando seu orçamento mais devagar que o tempo passa |
| **> 100%** | Acelerado — nesse ritmo você bate o teto antes do reset |

**Buckets:**

| Pace | Ícone | Cor | Significado |
|---|---|---|---|
| < 70% | 🐢 chill | 🟢 verde | Bastante folga, pode gastar à vontade |
| 70–99% | 🚶 ok | 🟢 verde | Exatamente no ritmo |
| 100–129% | 🏃 fast | 🟡 âmbar | Acelerado, segura um pouco |
| ≥ 130% | 🔥 hot | 🔴 vermelho | Muito acima, vai bater o teto cedo |

**Exemplo 1:** você usou 30% do limite em 1h da janela de 5h. Pace = `0.30 / 0.20 = 1.50` → `🔥 hot 150%`. Tradução: nesse ritmo bate 100% em ~3h20, segura.

**Exemplo 2:** usou 60% em 4h. Pace = `0.60 / 0.80 = 0.75` → `🐢 chill 75%`. Tradução: tem orçamento sobrando pra última hora.

**Nota:** nos primeiros 2% da janela (~6min), o pace fica oculto pra evitar números doidos (3000%, 12000%) que não são úteis.

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
