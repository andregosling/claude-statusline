# claude-statusline

Two-line dashboard status line for Claude Code. Single file: `statusline.js`. Zero dependencies (only Node).

## Versionamento (semver de verdade — IMPORTANTE)

**Não suba o minor para todo ajuste.** O histórico já teve version inflation (v2.3→2.4→2.5→2.6 para mudancinhas de comportamento). Nesse ritmo chega em v15 sem mudança estrutural. O número tem que refletir o **tamanho real** da mudança.

| Bump | Quando | Exemplo |
|---|---|---|
| **patch** (`2.6.1` → `2.6.2`) | Refinamento, fix de bug, ou ajuste de comportamento que **já existia** | Badge de effort que sumia em `xhigh`/`max` passar a aparecer; pace que já existia passar a sempre renderizar |
| **minor** (`2.6` → `2.7`) | Feature nova de verdade — segmento novo, comando novo, capacidade nova | Adicionar um indicador de rate limit que não existia |
| **major** (`2.x` → `3.0`) | Rewrite ou breaking change | Mudar formato de saída, remover env vars |

Classifique a mudança **honestamente** antes de escolher o bump. Badge pequeno em cima de um fix = patch, não minor.

### Ao mudar a versão, atualizar os DOIS lugares em `statusline.js`:
1. Comentário `// VERSION:` (linha ~4)
2. Const `VERSION = '...'` (linha ~15)

Os dois têm que bater — o auto-update lê o comentário do remoto, o renderer compara com a const.

## Auto-update — cuidado ao desenvolver

`statusline.js` se auto-atualiza: ao rodar, `maybeScheduleUpdate()` spawna um processo em background que baixa o `statusline.js` do `main` no GitHub e **sobrescreve o arquivo local**. Em dev isso significa que rodar `node statusline.js` para testar pode **reverter suas edições não-commitadas** para a versão do remoto.

Ao testar mudanças locais:
- Prefira `node -c statusline.js` (só checa sintaxe, não executa o render nem dispara o update).
- Se precisar rodar o render de verdade, saiba que o background update pode clobber o arquivo. Commite/stashe antes, ou rode uma vez só e re-verifique o estado.
- O cache do update fica em `~/.claude/cache/claude-statusline/` (`last-check`, `last-session`, `remote-version`).
- O remoto (`main`) pode estar **atrás** do estado local — nesse caso o auto-update "rebaixa" o arquivo. Pushe antes de testar.

## Contexto do payload

Claude Code passa JSON via stdin. Campos relevantes documentados em https://code.claude.com/docs/en/statusline — ver seção "Available data". `context_window.total_input_tokens` é snapshot per-turn (desde CC v2.1.132), não cumulativo de sessão.
