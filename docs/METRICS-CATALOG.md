# Catálogo de Métricas — claude-statusline → API de Telemetria

> **Para**: equipe que vai construir a API de ingestão de métricas
> **De**: Andre Gosling (gestão / arquitetura)
> **Status**: especificação de dados. Lista TUDO que dá pra coletar do Claude Code via statusline.
> **Versão statusline de referência**: 2.6.2
> **Doc relacionado**: `docs/TELEMETRY-PLAN.md` (auth, cadência de envio, threat model, LGPD)

---

## 0. Como ler este documento

A statusline (`statusline.js`) roda no laptop de cada dev e recebe, a cada render, um **JSON via stdin** mandado pelo próprio Claude Code. Esse JSON é a **fonte de toda métrica**. A statusline hoje só *exibe* uma fração dele — mas pode *coletar e enviar tudo*.

Cada métrica abaixo tem:

| Coluna | Significado |
|---|---|
| **Campo (payload)** | Caminho exato no JSON do Claude Code. `—` = derivado, não vem pronto. |
| **Tipo** | Tipo do dado bruto. |
| **Exibido hoje?** | Se a statusline v2.6.2 mostra na barra. |
| **Significado** | O que o número quer dizer. |
| **Uso pra gestão** | Por que você, como gestor, quer isso. |
| **Agregação sugerida (backend)** | Como a API deveria guardar/sumarizar. |

⚠️ **Natureza dos dados — ler antes de modelar o banco:**
- O payload é um **snapshot do momento do render**, não um acumulado de sessão (com exceção dos campos de `cost.*`, que são cumulativos da sessão).
- `context_window.*` desde o Claude Code v2.1.132 é **per-turn** (estado atual da janela), não cumulativo. Antes disso era cumulativo — daí a importância de coletar `version`.
- A statusline renderiza várias vezes por minuto. A telemetria **não** deve enviar todo render — ver cadência no `TELEMETRY-PLAN.md` (heartbeat 60s).

---

## 1. Identidade & Sessão

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `session_id` | string | Não (uso interno p/ detectar sessão nova) | ID único da sessão do Claude Code | Unidade base de "uma sessão de trabalho". Conta sessões/dia por dev. | Chave de agrupamento. `sessions` table, 1 linha por session_id. |
| `session_name` | string (pode faltar) | **Não** | Nome custom dado via `--name` ou `/rename` | Dev nomeia o que está fazendo ("refactor-auth"). Sinal qualitativo do tipo de trabalho. | Guardar como label da sessão. Texto livre. |
| `transcript_path` | string | **Não** | Caminho do arquivo de transcript local | Não enviar o conteúdo (privacidade). Só serve pra saber que existe. | **Não coletar** o path absoluto (vaza estrutura de pastas). Ignorar. |
| `version` | string | **Não** | Versão do Claude Code do dev | Saber quem está desatualizado; interpretar campos cuja semântica mudou entre versões. | Guardar por evento. Dashboard "distribuição de versões". |
| `agent.name` | string (pode faltar) | **Não** | Nome do agente quando rodando com `--agent` | Saber se o dev usa subagents/agentes custom — sinal de maturidade no uso da ferramenta. | enum/text por evento. Contar % de tempo em modo agente. |
| `output_style.name` | string | **Não** | Nome do output style ativo | Baixo sinal, mas trivial de coletar. | text. Opcional. |
| — `machine_id` | string (derivado) | n/a | Hash estável (hostname+MAC) gerado pelo cliente | Distinguir "mesmo dev em 2 máquinas". | Derivar no cliente, enviar hash. |
| — `statusline_version` | string (constante) | n/a | Versão do `statusline.js` (`2.6.2`) | Saber se todo mundo tem a versão que coleta os campos novos. | Constante no script, enviar por evento. |

---

## 2. Modelo & Configuração de Raciocínio

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `model.id` | string | **Sim** (mapeado p/ "Opus 4.7" etc.) | ID do modelo (`claude-opus-4-7`, `claude-sonnet-4-6`...) | **Métrica central**: quem usa Opus (caro/capaz) vs Sonnet/Haiku (barato/rápido) pra quê. Custo é função direta disso. | enum por evento. Dashboard: % de tempo / % de custo por modelo, por dev e por time. |
| `model.display_name` | string | **Sim** (fallback) | Nome amigável do modelo | Backup do `model.id` se vier id desconhecido. | text. Fallback. |
| `effort.level` | enum: `low`/`medium`/`high`/`xhigh`/`max` (pode faltar) | **Sim** (badge — corrigido na v2.6.2 p/ cobrir `xhigh`/`max`) | Nível de esforço de raciocínio configurado | Dev no `max` o tempo todo = custo e latência altos; pode ser legítimo ou desperdício. Dev sempre no `low` em tarefa complexa = subutilização. | enum por evento. Distribuição de effort por dev/modelo. Cruzar com custo. |
| `thinking.enabled` | boolean | **Sim** (badge `think` — novo na v2.6.2) | Se o extended thinking está ligado | Sinal separado do effort. Thinking ligado custa mais tokens de saída mas melhora resultado em tarefa difícil. | boolean por evento. % de tempo com thinking on, por dev. |

---

## 3. Custo & Produção de Código

> Estes são os ÚNICOS campos **cumulativos da sessão** no payload — crescem monotonicamente até a sessão acabar.

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `cost.total_cost_usd` | number (USD) | **Sim** (`$1.23`) | Custo estimado da sessão, calculado client-side. **Pode divergir da fatura real.** | **A métrica de ROI / capacity planning.** Custo por dev / projeto / dia / modelo. | numeric. Por sessão: pegar o valor MÁXIMO (é cumulativo). Somar máximos por dev/período. ⚠️ É estimativa — ver cross-check com fatura Anthropic no TELEMETRY-PLAN. |
| `cost.total_duration_ms` | int (ms) | **Sim** (`2m00s`) | Tempo de parede (wall-clock) desde o início da sessão | Quanto tempo a sessão ficou aberta. Sozinho não diz produtividade (pode estar aberta e ociosa). | bigint. Por sessão: valor MÁXIMO. |
| `cost.total_api_duration_ms` | int (ms) | **Não** | Tempo total esperando resposta da API | Cruzado com `total_duration_ms` dá a razão "% do tempo o modelo estava trabalhando vs. o dev lendo/digitando". Métrica de produtividade muito mais honesta. | bigint. Por sessão: máximo. **Derivar `api_ratio = api_duration / total_duration`.** |
| `cost.total_lines_added` | int | **Sim** (badge `+N`) | Linhas de código adicionadas na sessão | "Quanto código nasceu com IA". Volume de output. | int. Por sessão: máximo. Somar por dev/período. |
| `cost.total_lines_removed` | int | **Sim** (badge `-N`) | Linhas removidas na sessão | "Quanto código foi deletado/refatorado com IA". | int. Por sessão: máximo. Somar por dev/período. |

---

## 4. Janela de Contexto

> `context_window.*` é **per-turn** (estado atual da janela) desde o Claude Code v2.1.132. Antes era cumulativo — por isso colete `version`.

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `context_window.total_input_tokens` | int | **Sim** (`50.0k ctx`) | Tokens de input atualmente na janela (system prompt + tools + histórico). Inclui cache read/write. | "Quão cheia está a janela". Dev que enche a janela e não compacta = degradação de qualidade. | bigint snapshot. Por sessão: média e máximo. |
| `context_window.total_output_tokens` | int | **Sim** (`last +200`) | Tokens de output só do último turno (snapshot pequeno, muda todo render) | Pouco valor isolado. Não é total de sessão. | bigint snapshot. Pode somar por sessão p/ aproximar volume de output (impreciso). |
| `context_window.context_window_size` | int | **Não** | Tamanho MÁXIMO da janela (200000 padrão, ou 1000000 com contexto estendido) | Saber quem está em janela 1M. Sem isso, `%` engana. | int por evento. |
| `context_window.used_percentage` | number 0–100 (pode ser null) | **Sim** (barra + `%`) | % da janela usada (pré-calculado, só input) | **Métrica chave de "aproveitamento de contexto".** | numeric snapshot. Por sessão: média e máximo. |
| `context_window.remaining_percentage` | number 0–100 (pode ser null) | **Não** | % restante (= 100 − used) | Redundante com `used_percentage`. | Derivar, não precisa coletar. |
| `context_window.current_usage.input_tokens` | int (pode ser null) | **Não** | Tokens de input "fresco" (não-cache) do último turno | Numerador do cálculo de cache hit. | bigint snapshot. |
| `context_window.current_usage.cache_creation_input_tokens` | int (pode ser null) | **Não** | Tokens escritos no cache no último turno | Parte do cálculo de eficiência de cache. | bigint snapshot. |
| `context_window.current_usage.cache_read_input_tokens` | int (pode ser null) | **Não** | Tokens lidos do cache no último turno | **Cache read custa ~10% do input fresco.** Alta taxa de cache = uso eficiente e barato. | bigint snapshot. **Derivar `cache_hit_ratio = cache_read / (cache_read + input_tokens + cache_creation)`.** |
| `context_window.current_usage.output_tokens` | int (pode ser null) | **Não** | Tokens de output do último turno (= `total_output_tokens`) | Breakdown. | bigint snapshot. |
| `exceeds_200k_tokens` | boolean | **Não** | Se o total (input+cache+output) do último turno passou de 200k | Gatilho barato de "contexto gigante" mesmo em janela 1M (onde `%` ainda parece baixo). | boolean snapshot. % de eventos true por sessão. |

---

## 5. Rate Limits (planos Claude.ai Pro/Max)

> Só aparecem para assinantes Pro/Max, e só **depois da primeira resposta da API** na sessão. Cada janela pode estar ausente independentemente.

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `rate_limits.five_hour.used_percentage` | number 0–100 (pode faltar) | **Sim** (bolinha ● + cor) | % do limite de 5h consumido | **Quem está perto do teto.** Dev que vive batendo o cap de 5h precisa de tier maior; quem fica em 5% o dia todo subutiliza. | numeric snapshot. Por sessão/dia: média e máximo. |
| `rate_limits.five_hour.resets_at` | int (unix epoch s) | **Sim** (usado p/ "resets in 2h" e pro cálculo de pace) | Quando a janela de 5h reseta | Junto com o `used_percentage` permite calcular o **pace** (ver derivadas abaixo). | timestamp. Usado p/ derivar pace. |
| `rate_limits.seven_day.used_percentage` | number 0–100 (pode faltar) | **Não** | % do limite de 7 dias consumido | Limite semanal do plano. (Nota da gestão: raramente atingido — baixa prioridade, mas trivial de coletar.) | numeric snapshot. Por semana: máximo. |
| `rate_limits.seven_day.resets_at` | int (unix epoch s) | **Não** | Quando a janela de 7 dias reseta | Pra calcular pace semanal se desejado. | timestamp. |

---

## 6. Workspace & Projeto

| Campo (payload) | Tipo | Exibido hoje? | Significado | Uso pra gestão | Agregação sugerida (backend) |
|---|---|---|---|---|---|
| `workspace.current_dir` (= `cwd`) | string | **Sim** (path encurtado na barra) | Diretório de trabalho atual | Saber em que projeto o dev está. **Não enviar path absoluto** (vaza estrutura). | **Enviar só `sha256(path)`** = "mesmo projeto" sem saber qual. |
| `workspace.project_dir` | string | **Não** | Diretório onde o Claude Code foi lançado | Se diverge do `cwd`, o dev mudou de pasta na sessão. | sha256. Comparar com `current_dir` hash. |
| `workspace.git_worktree` | string (pode faltar) | **Sim** (badge `wt:`) | Nome do git worktree, se dentro de um | Sinal de uso avançado de git. | text/boolean. |
| `workspace.added_dirs` | array (vazio se nenhum) | **Não** | Diretórios extras via `/add-dir` | Quantos contextos extras o dev juntou. Uso avançado. | int (contagem). |
| `worktree.name` / `.branch` / `.path` / `.original_cwd` / `.original_branch` | strings (só em sessões `--worktree`) | Parcial | Metadados de sessão iniciada com `--worktree` | Uso avançado de isolamento. `.path` é absoluto — não enviar cru. | name/branch como text; paths → hash ou ignorar. |
| — git branch / ahead / behind / add / mod / del | derivado (statusline roda `git` localmente, **não vem no payload**) | **Sim** (segmento git da barra) | Estado do repositório | Hoje só exibido. Se quiser na telemetria, o cliente teria que coletar e enviar. **Cuidado**: nome de branch pode vazar info — avaliar com privacidade. | Opcional. Se coletar, branch como text, contadores como int. |

---

## 7. Métricas Derivadas (a API/dashboard calcula — não vêm prontas)

Estas são as métricas de **gestão de verdade**. Recomendação: o **cliente envia os campos brutos, o servidor deriva** — assim o dev não consegue mentir nas métricas derivadas (mesma lógica do TELEMETRY-PLAN).

| Métrica derivada | Fórmula (a partir dos campos brutos) | O que responde |
|---|---|---|
| **Pace (ritmo de consumo)** | `pace = (rate_5h_used / 100) / elapsed_fraction`, onde `elapsed_fraction = (5h − tempo_até_reset) / 5h` | "Esse dev vai estourar o limite de 5h antes da hora?". `1.0×` = bate 100% exato no reset; `>1.5×` = vai estourar cedo; `<0.7×` = folga. Statusline exibe como 🐢 chill / 🚶 ok / 🏃 fast / 🔥 hot. |
| **Pace médio do time** | média de `pace` por dev/dia, agregada no time | Capacity planning: time inteiro com pace alto = precisa de tier maior. |
| **Cache hit ratio** | `cache_read / (cache_read + input_tokens + cache_creation)` | Eficiência de uso. Alto = barato e bem aproveitado. Baixo = desperdício de tokens caros. |
| **API ratio (densidade de trabalho)** | `total_api_duration_ms / total_duration_ms` | "% do tempo de sessão em que o modelo estava de fato trabalhando" vs. sessão aberta ociosa. |
| **Custo por linha de código** | `total_cost_usd / (lines_added + lines_removed)` | ROI por output. Comparável entre devs/projetos. |
| **Custo por modelo / por projeto / por dev** | `sum(cost_usd)` agrupado | Capacity planning e atribuição de custo. |
| **Aproveitamento de contexto** | distribuição de `used_percentage` por sessão | Devs que enchem a janela sem compactar (qualidade cai) vs. devs que mantêm janela enxuta. |
| **Distribuição de effort/thinking** | % de tempo em cada `effort.level` e com `thinking.enabled` | Quem usa `max`+thinking pra tudo (caro) vs. quem nunca sobe o effort em tarefa difícil (subutiliza). |
| **Sessões por dev / dia** | `count(distinct session_id)` por dev/dia | Volume de uso. |
| **Tempo ativo por dev / dia** | `sum(total_duration_ms)` dos máximos por sessão | Quanto tempo de Claude Code por dia. |

---

## 8. Resumo: o que a statusline exibe hoje vs. o que dá pra coletar

**Exibido hoje na barra (v2.6.2):**
`model.id` · `effort.level` · `thinking.enabled` · `workspace.current_dir` · git (derivado local) · `workspace.git_worktree` · `cost.total_cost_usd` · `cost.total_duration_ms` · `cost.total_lines_added/removed` · `context_window.total_input_tokens` · `context_window.total_output_tokens` · `context_window.used_percentage` · `rate_limits.five_hour.used_percentage` + `.resets_at` (bolinha + pace)

**Coletável mas NÃO exibido hoje (recomendado pra telemetria):**
`session_id` · `session_name` · `version` · `agent.name` · `output_style.name` · `cost.total_api_duration_ms` · `context_window.context_window_size` · `context_window.current_usage.*` (cache!) · `exceeds_200k_tokens` · `rate_limits.seven_day.*` · `workspace.project_dir` · `workspace.added_dirs` · `worktree.*`

**Decisões de privacidade já tomadas (ver TELEMETRY-PLAN.md):**
- ❌ Nunca enviar conteúdo de prompt/resposta (não está no payload de qualquer forma).
- ❌ Nunca enviar path absoluto — só `sha256` do path.
- ❌ Nunca enviar `transcript_path`.
- ⚠️ Nome de branch / `session_name`: texto livre digitado pelo dev — avaliar caso a caso.

---

## 9. Para a equipe da API — próximos passos sugeridos

1. **Modelar o evento** a partir das tabelas acima. Campos `cost.*` são cumulativos (guardar máximo por sessão); o resto é snapshot (guardar média + máximo, ou série temporal se quiser granularidade).
2. **Derivar no servidor**, não confiar em derivada vinda do cliente (anti-fraude).
3. **Cadência**: não ingerir todo render. Ver heartbeat de 60s no `TELEMETRY-PLAN.md`.
4. **Cross-check de custo**: `cost.total_cost_usd` é estimativa client-side — bater contra a fatura real da Anthropic (uma API key por dev). Ver TELEMETRY-PLAN seção 5.
5. **Versionar o schema do evento** — o payload do Claude Code muda entre versões (ex: `context_window` mudou de cumulativo p/ per-turn na v2.1.132). Coletar `version` e `statusline_version` em todo evento.
