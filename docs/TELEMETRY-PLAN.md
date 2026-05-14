# Plano: Telemetria + Autenticação para claude-statusline

> **Status**: Idealização. Documento para revisão com a liderança técnica.
> **Autor**: Andre Gosling (Arquiteto de IA)
> **Data**: 2026-05-11
> **Decisão pendente**: aprovar/ajustar escopo antes de iniciar desenvolvimento.

---

## 1. Objetivo

Coletar métricas de uso real do Claude Code por desenvolvedor, para:

1. **Entender padrões de adoção** — quem usa muito, quem usa pouco, quem usa errado
2. **Identificar gargalos** — devs que batem o teto do rate limit consistentemente (precisam de tier maior?) vs devs que ficam em "chill" o dia inteiro (subutilização, falta de skill, ou ferramenta errada pro trabalho?)
3. **Capacity planning** — custo real por dev / projeto / modelo
4. **Coaching individual** — base factual para conversas 1:1 sobre uso da ferramenta
5. **ROI da ferramenta** — justificar investimento com dados

### Não-objetivos (importante deixar claro)

- ❌ **Não é** ferramenta de vigilância. Não vamos medir "tempo no Claude vs tempo no Slack".
- ❌ **Não é** input para avaliação de performance. Output não vai pra HR.
- ❌ **Não coleta** conteúdo de prompts, respostas, nomes de arquivos, código.
- ❌ Os devs vão **saber** que isso existe e o que coleta (LGPD compliance + confiança).

---

## 2. Arquitetura Proposta

```
┌──────────────────────┐
│  Dev's laptop        │
│                      │
│  ┌────────────────┐  │      ┌────────────────────┐
│  │ statusline.js  │──┼─────▶│  API (NestJS)      │
│  │ (cada 5s)      │  │ POST │  /events           │
│  └────────────────┘  │ JWT  │                    │
│         │            │      │  ┌──────────────┐  │
│  ┌──────▼─────────┐  │      │  │ /auth/login  │  │
│  │ ~/.claude/...  │  │      │  │ /auth/refresh│  │
│  │ token + cache  │  │      │  │ /events      │  │
│  └────────────────┘  │      │  │ /admin/*     │  │
│                      │      │  └──────────────┘  │
│  ┌────────────────┐  │      └─────────┬──────────┘
│  │ claude-        │  │                │
│  │ statusline     │  │      ┌─────────▼──────────┐
│  │ login          │──┼─────▶│  Postgres          │
│  │ (browser flow) │  │      │  - users           │
│  └────────────────┘  │      │  - sessions        │
└──────────────────────┘      │  - events          │
                              └────────────────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  Admin Dashboard   │
                              │  (Next.js / outro) │
                              └────────────────────┘
```

### Componentes

| Componente | Stack | Responsabilidade |
|---|---|---|
| **statusline.js** (client) | Node, já existe | Renderiza barra + coleta + envia eventos |
| **API** | NestJS + TypeORM + Postgres | Auth, ingestão de eventos, queries do admin |
| **Banco** | Postgres (Supabase ou self-hosted) | Users, sessions, events |
| **Admin dashboard** | Next.js (ou simples HTML server-side por NestJS) | Cadastro de devs, visualização de métricas |
| **Token storage** | Arquivo local `~/.claude/cache/claude-statusline/auth.json` | JWT + refresh token, mode 600 |

---

## 3. Autenticação — Fases

### Fase 1 (MVP): Email + Senha

**Por quê primeiro:**
- Permite validar o conceito todo antes de pedir integração Azure AD da TI
- Mais rápido de implementar (1-2 semanas)
- Mesma arquitetura serve depois, só troca a tela de login

**Fluxo:**

1. **Admin cadastra dev** no painel:
   ```
   POST /admin/users
   { email: "dev@empresa.com", name: "Dev Name", temp_password: "auto-gerada" }
   ```
   Email é enviado pro dev com a senha temporária.

2. **Dev roda `claude-statusline login`** no terminal:
   - Abre browser numa URL local (ex: `http://localhost:7423/login`)
   - Tela de login mostra email + senha
   - Backend valida → retorna JWT (24h) + refresh token (30d)
   - CLI salva em `~/.claude/cache/claude-statusline/auth.json` (mode 600)
   - Primeiro login obriga troca de senha

3. **Statusline lê o token** a cada render. Se válido → eventos vão com `Authorization: Bearer ...`. Se expirado → tenta refresh em background. Se refresh falhar → mostra `🔒 sign in` clicável.

4. **Refresh automático**: quando JWT está a < 1h de expirar, statusline dispara renovação em background. Dev nunca percebe.

### Fase 2: Migração para Azure AD (SSO)

**Quando**: depois que o MVP for aprovado e estiver rodando.

**Mudanças**:
- Adiciona endpoint `/auth/azure/callback`
- CLI `login` abre URL do Azure (OAuth Authorization Code com PKCE)
- Dev autentica com conta da empresa
- Backend troca code por id_token, cria/atualiza user, emite JWT próprio
- Tudo abaixo da camada de auth fica idêntico (mesmos endpoints `/events`, mesmo JWT, mesmo dashboard)

**Suporte aos dois em paralelo**: provavelmente sim por uns 3 meses, pra não quebrar os devs cadastrados na Fase 1.

---

## 4. Coleta de Métricas

### O que coletar (campos brutos)

Eventos vêm direto do payload do Claude Code que o statusline já recebe a cada 5s. **Cliente envia raw fields, servidor deriva pace/buckets** — isso impede dev de mentir nas métricas derivadas.

| Campo | Origem | Tipo |
|---|---|---|
| `ts` | Server-side timestamp | timestamptz |
| `client_ts` | Hora local do dev | timestamptz |
| `user_id` | JWT claim | uuid |
| `session_id` | `payload.session_id` | text |
| `machine_id` | hash estável (hostname + MAC) | text |
| `event_type` | `heartbeat` / `session_start` / `session_end` / `pace_change` | enum |
| `cost_usd` | `payload.cost.total_cost_usd` | numeric |
| `duration_ms` | `payload.cost.total_duration_ms` | bigint |
| `lines_added` | `payload.cost.total_lines_added` | int |
| `lines_removed` | `payload.cost.total_lines_removed` | int |
| `tokens_in` | `payload.context_window.total_input_tokens` | bigint |
| `tokens_out` | `payload.context_window.total_output_tokens` | bigint |
| `context_pct` | `payload.context_window.used_percentage` | smallint |
| `rate_5h_pct` | `payload.rate_limits.five_hour.used_percentage` | numeric |
| `rate_5h_reset` | `payload.rate_limits.five_hour.resets_at` | timestamptz |
| `model_id` | `payload.model.id` | text |
| `effort_level` | `payload.effort.level` | enum |
| `project_hash` | sha256(`workspace.project_dir`) | text |
| `cc_version` | `payload.version` | text |
| `statusline_version` | constante no script | text |

### O que NÃO coletar (decisões já tomadas)

- ❌ Conteúdo de prompts / respostas (não está no payload, ainda bem)
- ❌ Nomes de arquivos editados
- ❌ Path absoluto do projeto (só **hash** — você sabe "mesmo projeto" sem saber qual)
- ❌ IP origem do request (servidor pode logar para abuse, mas não correlaciona com user no schema)

### Cadência de envio

- **Heartbeat a cada 60s** durante sessão ativa (12 renders, 1 envio)
- **Evento extra a cada mudança de pace_bucket** (chill → fast → etc.)
- **Buffer local** em `events.jsonl` se rede falhar; flush em batches de até 100 eventos
- **Envio fire-and-forget**: nunca bloqueia o render. Spawn de child process detached.

### Dashboards do admin (Fase MVP)

A partir das respostas escolhidas, o dashboard mostra:

1. **Tempo total ativo por dev/dia** — gráfico de barras, granularidade dia/semana/mês
2. **Distribuição de pace (chill/ok/fast/hot)** — stacked area chart, % do tempo em cada bucket
3. **Custo total Anthropic por dev** — tabela com sum(`cost_usd`) por user/período
4. **Modelos mais usados + projetos** — pie chart de model_id, tabela de project_hash count

### Cross-check com a fatura da Anthropic

Crítico: dê **uma API key Anthropic por dev** (ou ative billing por workspace dentro do console Anthropic). Anthropic envia relatório de uso real. Compare com a soma de `cost_usd` que chega no telemetry — se divergirem, sinal de problema.

---

## 5. Threat Model — O que conseguimos garantir

### Garantimos

- ✅ **Identidade**: o `user_id` no evento foi autenticado contra a sua plataforma. Dev sabe a senha dele, ninguém mais sabe (assumindo que ele não compartilhou).
- ✅ **Integridade de transporte**: HTTPS obrigatório. Token Bearer.
- ✅ **Não-repúdio leve**: você consegue dizer "esse user_id mandou esses eventos com esse JWT em tal IP em tal hora".

### Não garantimos (e o documento precisa ser honesto)

- ❌ **Que o dev não compartilhou a senha** com outro dev. Mitigação: senha forte + obrigatória troca + logs de IP/device suspeitos.
- ❌ **Que o dev não editou o `statusline.js` localmente** pra mandar dados falsos. Mitigação: servidor recalcula derivações + cross-check com fatura Anthropic + flag se valores impossíveis.
- ❌ **Que o dev rodou o statusline o tempo todo**. Se ele matar o processo, simplesmente não há eventos. Mitigação: relatório semanal "X horas de Claude Code aberto, Y eventos de telemetria — diferença suspeita?".
- ❌ **Roubo de token do disco**: token salvo em `~/.claude/...` mode 600. Outro processo na mesma máquina com mesmo user consegue ler. Aceitável.

### O killer real: cross-check com a Anthropic

Mesmo se dev burlar 100% do statusline, a Anthropic **te manda a fatura por API key**. Se você der uma key por dev, a Anthropic é fonte de verdade do quanto cada um gastou. O statusline é fonte do **como** gastou (ritmo, modelos, projetos) — que é o sinal mais rico, e justamente o que não dá pra obter pela fatura.

---

## 6. Privacy / LGPD / Confiança

- **Opt-in informado**: termo de uso no primeiro login explica exatamente o que é coletado e pra quê
- **Acesso aos próprios dados**: endpoint `/me/data` permite dev baixar tudo que existe sobre ele
- **Direito ao apagamento**: endpoint `/me/delete` apaga tudo (LGPD art. 18)
- **Não compartilhado externamente**: dados ficam dentro do banco da empresa, não vão pra terceiros
- **Retenção definida**: 90 dias granular + agregados anuais. Dados crus apagados depois.
- **Anonimização para reports executivos**: agregados por time, não por indivíduo, exceto em contexto de coaching 1:1
- **Não usado para HR / avaliação**: declaração explícita no termo

---

## 7. UX do Statusline

### Estado: autenticado
```
╭─  ~/code/projeto · ⎇ main · 󰚩 Opus 4.7
╰─  $0.42 · 43k tok · 18m · ███░░░░░ 30% · ● 5h · resets in 2h14m · 🐢 chill 0.5× · (?)
```
Sem nada novo. Telemetria roda invisível.

### Estado: não autenticado
```
╭─  ~/code/projeto · ⎇ main · 󰚩 Opus 4.7
╰─  $0.42 · 43k tok · 18m · ███░░░░░ 30% · ● 5h · resets in 2h14m · 🐢 chill 0.5× · 🔒 sign in · (?)
```

`🔒 sign in` aparece em **vermelho/âmbar**, clicável (OSC 8 hyperlink). Cmd+click abre uma URL de instruções no GitHub (ou no admin panel). Dev roda `claude-statusline login` no terminal pra autenticar.

### Estado: token expirado, refresh falhou
Mesmo `🔒 sign in` — UX idêntica. Renovação tenta sozinha em background; só vira badge se falhar.

### Comandos novos no CLI

| Comando | O que faz |
|---|---|
| `claude-statusline login` | Abre browser pra login, salva token |
| `claude-statusline logout` | Apaga token local |
| `claude-statusline whoami` | Mostra qual user está autenticado |
| `claude-statusline doctor` | Verifica conectividade com API, validade do token, etc. |

---

## 8. Roadmap MVP (estimativa)

| Etapa | Duração | Entregável |
|---|---|---|
| 1. NestJS API base + Postgres schema | 2 dias | `/auth/login`, `/auth/refresh`, `/events` funcionando |
| 2. Admin endpoints + cadastro de devs | 2 dias | `/admin/users` CRUD, hash bcrypt, envio de email |
| 3. CLI `login` + token storage | 1 dia | Fluxo browser → token salvo |
| 4. Telemetry no `statusline.js` | 2 dias | Buffer local + flush em background |
| 5. Badge `🔒 sign in` no renderer | 0.5 dia | Estado visual de auth |
| 6. Admin dashboard (HTML simples) | 3 dias | 4 dashboards descritos acima |
| 7. Termo LGPD + página de privacy | 0.5 dia | Texto + endpoint de aceite |
| 8. Onboarding doc interno | 0.5 dia | Como TI cadastra dev e como dev faz login |
| 9. Deploy + monitoramento | 1 dia | API no Cloud Run / similar + logs |

**Total estimado**: ~12-15 dias úteis (1 dev focado), pode reduzir com mais paralelismo.

### Fora do MVP (Fase 2+)

- Migração Azure AD SSO
- Webhooks pra avisar admin de eventos suspeitos
- Notificações pro dev sobre seu próprio uso ("você está em hot 1.8× há 2h, considere pausar")
- API pública pra dev consumir suas próprias métricas
- Integração com BigQuery/Datalake da empresa
- Alertas automáticos (ex: dev sem eventos há 7 dias)

---

## 9. Riscos & Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Devs resistirem por sensação de vigilância | Alta | Alto | Comunicação aberta + opt-in informado + propósito claro + sem uso pra HR |
| Vazamento do banco com nomes de devs | Baixa | Alto | Encrypted-at-rest + acesso restrito + audit logs |
| API key da Anthropic compartilhada acidentalmente | Média | Alto | Uma key por dev, gerenciada via vault da empresa |
| Statusline quebra em produção | Média | Médio | Eventos são fire-and-forget; falha de telemetria nunca quebra o render |
| Custo de infra explodir | Baixa | Médio | Dimensionar: ~30 devs × 1 evento/min × 8h × 22 dias = ~370k eventos/mês — Postgres trivial |
| Dev mente nos dados manipulando o script | Média | Baixo | Cross-check com fatura Anthropic + servidor recalcula derivações |

---

## 10. Decisões pendentes (para revisar com superiores)

- [ ] **Aprovação da iniciativa em si** — tem buy-in da liderança?
- [ ] **Quem hospeda a API**: AWS / GCP / on-prem?
- [ ] **Comunicação aos devs**: quem comunica, quando, com que tom?
- [ ] **Política de retenção**: 90 dias é suficiente? Auditoria pede mais?
- [ ] **Quem é admin no painel**: só você? Time todo? Tem RBAC desde MVP ou depois?
- [ ] **Fase 2 (Azure AD) é prioridade alta ou pode esperar 3+ meses?**
- [ ] **Dashboards para os próprios devs verem seus dados**: MVP ou Fase 2?
- [ ] **Orçamento aprovado para 1 dev focado por ~3 semanas?**

---

## 11. Perguntas abertas (técnicas)

1. **Multi-machine por dev**: se andre usa laptop + desktop, eventos devem ser mergeados por `user_id` ou separados por `machine_id`?
   - Sugestão: agregar por `user_id` por padrão; admin pode drillar por `machine_id` quando útil.
2. **Sessões cruzando midnight**: como cortar duração para dashboards diários?
   - Sugestão: cortar em UTC midnight no agregador.
3. **Edge case do Claude Code**: o que acontece se Claude Code não emitir `rate_limits` (ex: plano enterprise sem limit)?
   - Sugestão: campos nullable, server tolera.
4. **Modo offline**: dev em avião enche o buffer; quando volta, mandar 8h de eventos de uma vez. Servidor aguenta? Tem rate limit?
   - Sugestão: aceitar batches grandes (até 1000 eventos), rate limit por minuto por user.

---

## 12. Próximos passos (se aprovado)

1. Fechar decisões pendentes da seção 10 com a liderança
2. Criar repositório privado `claude-statusline-telemetry` (separado deste público)
3. Definir schema final do Postgres (revisar campos da seção 4)
4. Sketch da tela de admin (Figma ou ASCII) antes de codar
5. Comunicação interna pros devs (post no Teams + reunião 30min)
6. Sprint 1: API base + auth + CLI login (5 dias)
7. Sprint 2: ingestão + dashboards (5 dias)
8. Soft launch com 3-4 devs voluntários (1 semana)
9. Rollout pro time todo

---

## Apêndice A: Schema Postgres (esboço)

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'dev', -- 'dev' | 'admin'
  must_change_password boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  deleted_at    timestamptz
);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  machine_id text,
  user_agent text
);

CREATE TABLE sessions (
  id             text PRIMARY KEY, -- vem do Claude Code
  user_id        uuid NOT NULL REFERENCES users(id),
  machine_id     text NOT NULL,
  started_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  cc_version     text,
  model_id       text
);

CREATE TABLE events (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  client_ts      timestamptz NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  session_id     text NOT NULL,
  machine_id     text NOT NULL,
  event_type     text NOT NULL,
  cost_usd       numeric(10, 4),
  duration_ms    bigint,
  lines_added    int,
  lines_removed  int,
  tokens_in      bigint,
  tokens_out     bigint,
  context_pct    smallint,
  rate_5h_pct    numeric(5, 2),
  rate_5h_reset  timestamptz,
  model_id       text,
  effort_level   text,
  project_hash   text,
  pace           numeric(5, 2),       -- calculado no servidor
  pace_bucket    text,                -- calculado no servidor
  raw            jsonb,               -- payload completo p/ debug
  INDEX (user_id, ts),
  INDEX (session_id),
  INDEX (project_hash)
);
```

---

## Apêndice B: Endpoints da API (esboço)

```
# Auth
POST   /auth/login              { email, password }            → { jwt, refresh_token, must_change_password }
POST   /auth/refresh            { refresh_token }              → { jwt, refresh_token }
POST   /auth/logout             (auth)                          → 204
POST   /auth/change-password    { old_password, new_password } → 204

# Self-service
GET    /me                      (auth)                          → user profile
GET    /me/data                 (auth)                          → ZIP de todos os eventos do user
DELETE /me/data                 (auth, confirma com senha)      → apaga eventos do user

# Ingestion (chamado pelo statusline)
POST   /events                  (auth) { events: [...] }       → 202

# Admin
POST   /admin/users             (admin) { email, name }        → { user, temp_password }
GET    /admin/users             (admin)                         → users[]
GET    /admin/users/:id/metrics (admin, range)                  → metrics
GET    /admin/stats             (admin, range)                  → org-wide aggregates
DELETE /admin/users/:id         (admin)                         → soft delete
```

---

## Fim do documento

**Próxima ação**: revisar este documento com a liderança, marcar checkboxes da seção 10, ajustar escopo se necessário, e dar GO/NO-GO para começar o desenvolvimento.
