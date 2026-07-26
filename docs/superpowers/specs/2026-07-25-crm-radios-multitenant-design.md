# CRM Multi-Tenant para Rádios — Documento de Design (v1)

- **Data:** 2026-07-25
- **Status:** Aprovado para plano de implementação
- **Revisão:** rev2 (2026-07-26) — 2ª passada de revisão: completude/segurança/LGPD (N1–N13). Ver §16 Changelog.
- **Fonte:** "PROMPT MESTRE — Desenvolvimento de CRM Multi-Tenant para Rádios" (fornecido pelo proprietário)
- **Autor da revisão:** sessão de brainstorming (Claude Code)

Este documento consolida as decisões tomadas na sessão de brainstorming, refina a especificação-mestre e define o **plano de desenvolvimento em blocos**. Ele é a base para o plano de implementação (skill `writing-plans`).

---

## 1. Decisões-chave (fixadas nesta sessão)

| # | Decisão | Escolha | Consequência |
|---|---------|---------|--------------|
| D1 | Plataforma | **Greenfield no Supabase/PostgreSQL** | O app existente em `pulsar-listener-crm` (Next.js + Prisma + SQL Server + NextAuth) é **arquivado**. O banco SQL Server legado do sistema "Listener" vira **apenas fonte de migração (ETL único)**. |
| D2 | WhatsApp | **Core no v1** | Ingestão real de participações via WhatsApp Cloud API já no v1 (webhook com assinatura, idempotência, processamento assíncrono, reprocesso). |
| D3 | Módulo Músicas | **No v1, com migração** | Domínio de músicas (catálogo, categorias, pedidos, programas) — **ausente na §22 da spec** — precisa ser **modelado do zero** e migrado do legado. |
| D4 | Isolamento de tenant | **RLS + camada de serviço (defesa em profundidade)** | RLS ligada em toda tabela multi-tenant usando o JWT do usuário; backend opera com o token do usuário para dados de tenant; `service_role` restrito a rotinas de sistema (webhook, cron, ETL). |
| D5 | Sequenciamento | **Núcleo-primeiro com fatia vertical (estratégia A)** | Fundação e multi-tenant primeiro; estoque de-riscado antes de tudo que depende dele; auditoria/observabilidade/testes de isolamento como cross-cutting desde o início. |

**Regra para decisões não especificadas** (herdada da §36 da spec): escolher a alternativa **mais segura** e **mais simples de manter**, documentar, e criar **configuração por empresa** quando a regra puder variar.

**Prioridades, nesta ordem:** segurança → integridade dos dados → isolamento multi-tenant → correção das regras de estoque → rastreabilidade → usabilidade → desempenho → extensibilidade → aparência.

---

## 2. Visão do produto

CRM multi-tenant para emissoras de rádio gerenciarem o **relacionamento com ouvintes** e todo o **ciclo de distribuição de prêmios** de promoções. **Não** é CRM de vendas.

Domínios: organizações → empresas/rádios → (ouvintes, prêmios, estoque, promoções, quizzes, participações, sorteios, entregas, retornos, músicas, relatórios, integrações).

Terminologia obrigatória (§2 da spec): **Usuário** (acesso administrativo), **Ouvinte** (base da rádio, sem acesso ao painel no v1), **Empresa/Rádio** (tenant de negócio), **Organização** (agrupa empresas de um proprietário/grupo).

---

## 3. Arquitetura

### 3.1 Stack

- **Frontend/Backend:** Next.js (App Router), React, **TypeScript strict** (sem `any` sem justificativa), Server Components por padrão, Client Components só quando necessário. Server Actions e API Routes com separação clara de responsabilidades.
- **UI:** Tailwind CSS + **shadcn/ui (Radix)** — acessível, sem lock-in. *(Substitui a mistura Bootstrap+Tailwind do app legado.)*
- **Formulários/validação:** React Hook Form + **Zod** (validação em runtime, tipos derivados).
- **Tabelas/estado servidor:** TanStack Table + TanStack Query; virtualização quando necessário.
- **Gráficos:** Recharts. **Datas:** date-fns (+ date-fns-tz). **Export:** ExcelJS (Excel), CSV nativo, **`@react-pdf/renderer`** (PDF). *(L3: uma única lib de PDF.)*
- **Banco/infra:** Supabase (PostgreSQL, Auth, Storage, RLS, migrations, funções PL/pgSQL, `pg_cron`, Edge Functions e Realtime **só onde agregam valor**).
- **Testes (N9):** **Vitest** (unit/serviços), **Playwright** (e2e), e testes de **RLS/DB** com **pgTAP** *ou* harness que autentica como usuário real (JWT). *(Detalhe em §11.)*
- **E-mail transacional do app (N10):** provedor desacoplado via interface `mailer` — **SMTP** (config por ambiente) com **Resend** como opção gerenciada. E-mails de **Auth** (confirm/reset/convite) usam o mecanismo do Supabase Auth; **notificações do app** usam o `mailer`.
- **Rate limiting (N6):** store **compartilhado** (serverless não tem memória entre instâncias) — padrão **contador no Postgres** (tabela `rate_limit_counters` + função atômica); **Upstash Redis** como opção se o volume exigir. Interface desacoplada.
- **Deploy:** Dockerfile completo + alvo Vercel (app) + Supabase gerenciado. Camada de armazenamento e integrações **desacopladas** para não acoplar a um único provedor.

### 3.2 Camadas (por feature)

```
UI (Server/Client Components)
  → Server Actions / API Routes  (autenticação + orquestração)
    → services/       (regra de negócio, autorização granular, orquestração)
      → repositories/ (acesso a dados/queries via client do usuário → RLS aplicada)
        → RPC PL/pgSQL (operações atômicas críticas: estoque, sorteio, entrega)
schemas/  (Zod)   permissions/  (RBAC)   audit/  (trilha)   lib/integrations/ (desacoplada)
```

Regras: sem lógica de negócio dentro de componentes React; sem duplicação de regra em múltiplos lugares; arquivos focados (um propósito claro por unidade).

**H2 — Onde vivem as transações.** Com o client de usuário via PostgREST/JWT (D4) **não** se executa transação multi-statement interativa a partir do Next.js. Portanto, **toda operação atômica multi-passo (vincular, desvincular, reservar, sortear, cancelar sorteio, entregar, retornar, baixar, ajustar) é encapsulada em uma função PL/pgSQL chamada por RPC** (`.rpc(...)`). A camada `services/` orquestra e valida permissão; a atomicidade e as invariantes ficam na função do banco. Leituras e CRUD simples continuam por PostgREST com RLS.

### 3.3 Dois clients Supabase (decisão D4)

- **Client de usuário (padrão):** criado por requisição com o **JWT/sessão do usuário**. Toda leitura/escrita de dados de tenant passa por ele → **RLS é aplicada de fato**.
- **Client de sistema (`service_role`, isolado):** usado **somente** em: webhook do WhatsApp, jobs de cron, ETL de migração e operações de plataforma. Nunca exposto ao cliente; nunca usado para atender request de usuário comum.
- **Funções `SECURITY DEFINER` re-autorizam por conta própria (H2/H3).** Funções RPC que precisem escrever o ledger/projeção ou consultar no escopo da organização podem rodar como `SECURITY DEFINER` (contornando RLS). Nesse caso **é obrigatório** re-checar tenant + permissão **dentro do corpo** da função (`has_company_access`, `has_permission`), pois a RLS não as protege. Auditar toda invocação.

A camada de serviço **sempre** valida permissão granular antes de operar (autorização no backend), mesmo com RLS ligada — defesa em profundidade.

### 3.4 Estrutura de pastas (alvo)

```
src/
  app/ components/
  features/ { auth, organizations, companies, users, listeners, prizes,
              inventory, promotions, quizzes, participations, draws,
              deliveries, returns, music, reports, integrations, admin }
  lib/ services/ repositories/ schemas/ types/ hooks/ utils/ constants/
  permissions/ audit/
supabase/ { migrations/, seed/, functions/ }
tests/ docs/
```

---

## 4. Modelo de dados

### 4.1 Tabelas da spec (§22) — mantidas

Identidade/tenant: `profiles, organizations, organization_members, companies, company_members, roles, permissions, role_permissions, member_roles, invitations` *(N1)*.

Ouvintes: `listeners, listener_company_links, listener_consents, listener_notes, listener_documents, listener_blocks`.

Prêmios/estoque: `prize_categories, prizes, inventory_movements` (ledger), `inventory_balances` (projeção por prêmio), `promotion_prize_balances` (projeção por promoção — ver §5/H1).
- **M1:** `inventory_locations` e os movimentos `TRANSFER_IN/TRANSFER_OUT` **saem do v1** (YAGNI). O saldo é por `(empresa, prêmio)`. Reintroduzir `location_id` só quando houver depósito múltiplo real.

Promoções: `promotions, promotion_whatsapp_settings, promotion_requested_fields, promotion_questions, promotion_question_options, promotion_prizes`.

Participações/sorteio/entrega: `participations, participation_answers, draws, draw_entries, winners, winner_status_history, deliveries, delivery_documents, return_cases, return_case_history`.

Infra: `files, integrations, webhook_events, notifications, audit_logs, saved_reports`.
- **L3:** `files` é a **tabela genérica** de arquivos (bucket, path imprevisível, MIME, tamanho, owner, retenção); `listener_documents` e `delivery_documents` **referenciam** `files`. `notifications` no v1 tem canais **in-app** (padrão) e **e-mail** (via `mailer`, §3.1).

### 4.2 Domínio Músicas — **novo** (gap da §22, decisão D3)

Todas com `organization_id` + `company_id` + timestamps + soft delete:

- `music_genres` — categorias/gêneros de música. *(legado: derivado de `catalog_medias`)*
- `record_labels` — gravadoras. *(legado: `Cad_Gravadoras`)*
- `artists` — artistas/intérpretes. *(legado: `catalog_artists`)*
- `songs` (mídias) — título, `artist_id`, `label_id`, `genre_id`, **nacionalidade** (nacional/internacional), **gênero vocal** (masculina/feminina), duração, código interno, status. *(legado: `catalog_medias`)*
- `radio_shows` — programas da rádio. *(legado: `listener_shows`)*
- `music_requests` (pedidos musicais) — `listener_id`, `song_id`, `show_id`, canal/origem, `requested_at`, status. *(legado: `ouvintes_ped_musica`)*

Estes indicadores alimentam o **Dashboard de Músicas** (total, novas no período, mais pedida, categoria mais pedida, nacional/internacional, masculina/feminina).

### 4.3 Tabelas adicionais — **ideias incorporadas + achados**

- `idempotency_keys` — chave genérica reutilizável para Server Actions sensíveis (entrega, vínculo) além de webhooks (ideia #2).
- `entitlements` — recursos/limites contratados por empresa; base para o "Administrador libera recursos" e faturamento futuro (ideia #4).
- `outbox_messages` — outbox para saídas confiáveis (WhatsApp/IA/webhooks de saída) com reprocesso (ideia #5).
- `platform_admins` — vínculo de usuários que são **Administrador (dono do App)**, cross-tenant.
- `invitations` *(N1)* — convite de usuário: `organization_id`, `company_id?`, `email`, `role_id`, `token` (hash), `status` (`PENDING/ACCEPTED/REVOKED/EXPIRED`), `expires_at`, `invited_by`.
- `document_access_logs` *(N2)* — log por visualização de documento sensível: `file_id`, `listener_id?`, `company_id`, `viewed_by`, `viewed_at`, `ip`, `user_agent`, `purpose`.
- `rate_limit_counters` *(N6)* — contadores atômicos para rate limiting no Postgres (chave, janela, contagem) quando não se usar Redis.

### 4.4 Convenções de schema

UUID em PKs; `timestamptz` (armazenar em UTC, exibir no fuso da empresa); FKs, checks, unicidade e índices explícitos; **soft delete** (`deleted_at`), status e anonimização em vez de exclusão física; versionamento otimista onde necessário. Índices compostos por `organization_id`, `company_id`, `status`, datas, promoção, ouvinte, prêmio, **telefone normalizado** e **documento normalizado (hash)** — cada índice documentado (§22).

- **N5 — Unicidade × soft delete.** Toda restrição de unicidade de negócio (telefone/e-mail/CPF-hash/passaporte por org; código de integração de promoção; código interno de prêmio) é implementada como **índice único parcial** `... WHERE deleted_at IS NULL`, para permitir arquivar e recadastrar sem colidir com registros logicamente excluídos.
- **L2 — Fuso nos filtros de período.** Todo recorte "mês atual / mês anterior / ano atual / período personalizado / comparação" (dashboard e relatórios) calcula os limites **no fuso da empresa** (`companies.timezone`), não em UTC.

### 4.5 Ouvinte: escopo organização × acesso por empresa (H3)

O ouvinte é **compartilhado na organização** (dedup por org; a tela de detalhes mostra "empresas em que participou") mas o **acesso é por empresa**. Regra explícita:

- **Visibilidade:** um usuário só enxerga um `listener` que tenha `listener_company_links` para **ao menos uma empresa a que ele tem acesso** (RLS via `EXISTS` + `has_company_access`, nunca `USING (true)`).
- **Detalhes agregados entre empresas:** o histórico "empresas em que participou" só lista empresas a que o usuário tem acesso.
- **Dedup no escopo da org sem vazamento:** verificação de duplicidade via função **`SECURITY DEFINER`** no escopo da org que retorna apenas **"existe / não existe" (+ id quando o usuário já tem acesso)**. Fusão de duplicados exige permissão elevada e é auditada.

---

## 5. Regras de estoque (núcleo crítico)

Modelo **ledger + duas projeções** (§14.2–14.3, §24):

- `inventory_movements` = **ledger imutável**. Nunca editar/excluir; correção só por novo movimento.
- `inventory_balances` = **projeção por `(empresa, prêmio)`** (visão contábil de estoque).
- `promotion_prize_balances` = **projeção por `promotion_prize`** — vinculado / sorteado / entregue / restante **por promoção** (**H1**). Toda movimentação que cita promoção atualiza **as duas** projeções na mesma transação.

**Por que duas projeções (H1):** um mesmo prêmio pode estar vinculado a várias promoções ao mesmo tempo; "vinculado/sorteado/aguardando retirada/entregue" só fazem sentido por `(prêmio, promoção)`.

**Modelo de "baldes" (partição do estoque físico) e equação canônica (M5):**

```
estoque_físico     = disponível + reservado + vinculado + aguardando_retirada + retorno_pendente
estoque_utilizável = disponível           (livre para vincular/sortear; reservado NÃO conta)
(fora do físico)   = entregue, baixado
```

| Movimento | Efeito |
|-----------|--------|
| `INITIAL_ENTRY` / `PURCHASE_ENTRY` / `MANUAL_ENTRY` / `ADJUSTMENT_POSITIVE` | + disponível |
| `MANUAL_EXIT` / `ADJUSTMENT_NEGATIVE` | − disponível |
| `RESERVATION` / `RESERVATION_RELEASE` | disponível ↔ reservado |
| `PROMOTION_LINK` / `PROMOTION_UNLINK` | disponível ↔ vinculado |
| `DRAW` / `DRAW_CANCEL` | vinculado ↔ aguardando_retirada |
| `DELIVERY` | aguardando_retirada → entregue |
| `RETURN_PENDING` | aguardando_retirada → retorno_pendente |
| `RETURN_TO_STOCK` | retorno_pendente → disponível |
| `WRITE_OFF` | (retorno_pendente | aguardando_retirada) → baixado |

**Invariantes (validadas na função RPC, em transação, + `CHECK >= 0` em cada balde):** todo balde ≥ 0; cada transição confere o balde de origem antes de mover; não vincular > disponível; não sortear > vinculado; não entregar > aguardando_retirada; não desvincular abaixo do já sorteado (projeção por promoção — H1); não entregar o mesmo prêmio sorteado duas vezes (idempotência).

Toda operação roda em **função PL/pgSQL (RPC)** com **lock** (`SELECT ... FOR UPDATE` na linha de saldo) + **chave de idempotência** + registro em `audit_logs`. Ver H2 (§3.2/§3.3) sobre `SECURITY DEFINER`.

**Job de reconciliação** (ideia #3): recalcula ambas as projeções a partir do ledger e alerta divergências.

---

## 6. Sorteio, prazo e entrega

- **Sorteio** (§17): elegibilidade validada (exclui bloqueado), método manual ou aleatório com **CSPRNG** ou processo reproduzível/auditável (guardar seed + algoritmo); registra participantes elegíveis, parâmetros, ganhadores, suplentes e evidência de auditoria; permite cancelar/refazer com justificativa.
- **Efeito do sorteio no estoque:** movimento `DRAW` move vinculado → aguardando_retirada (nas duas projeções), associa ao ouvinte, impede dupla atribuição.
- **Cadeia referencial (M4):** `draw → winner → delivery` carrega `promotion_prize_id` (e `draw_id`/`winner_id`) para a **entrega decrementar o contador da promoção correta**. `deliveries` referencia `winners`; `winners` referencia `draw_entries`/`promotion_prizes`.
- **Prazo de retirada** (§18): **congelado no momento do sorteio**. Prêmio pode ter prazo padrão; promoção pode sobrescrever.
- **Cron de prazos** (`pg_cron` + Edge Function, idempotente): processa prazos vencidos → `RETURN_PENDING` + notifica; permite prorrogar/retornar/baixar. Falha de cron gera alerta (§31).
- **Suplentes (N8):** quando o ganhador não retira (retorno/baixa), há fluxo explícito **promover suplente**: cria novo `winner` a partir do suplente, **recalcula/rearma o prazo**, gera movimentação de estoque coerente (o prêmio volta de `retorno_pendente`/`aguardando_retirada` para o novo ganhador) e registra em `winner_status_history`.
- **Flag "permite retorno" (N11):** o fluxo de retorno respeita o campo `prizes.permite_retorno_ao_estoque`: se **verdadeiro**, oferece `RETURN_TO_STOCK`; se **falso**, o desfecho é `WRITE_OFF` (com motivo obrigatório). A UI não oferece retorno quando o prêmio não permite.
- **Entrega** (§13.4): fluxo transacional idempotente — localizar ouvinte → conferir → responsável/documento mascarado → **comprovante em bucket privado** → confirmar → movimento `DELIVERY` → auditoria → comprovante.

---

## 7. RBAC e permissões (§7)

Papéis: **Proprietário** (dono da organização), **Operador**, **Consulta**, e **Administrador = dono do App** (super-admin cross-tenant, via `platform_admins` / `is_platform_admin()`).

Papéis e permissões são **dados** (`roles, permissions, role_permissions, member_roles`), com granularidade por empresa. Permissões granulares (ex.: `listeners.create`, `inventory.reserve`, `promotions.publish`, `deliveries.execute`, `reports.export`, `users.invite`, `companies.manage`) + **`reports.consolidated`** para visão consolidada.

**Convites (N1):** o Proprietário/usuário com `users.invite` gera um `invitations` (token com hash + expiração) → e-mail via `mailer` → o convidado aceita (autentica no Supabase Auth) → o aceite cria `organization_members`/`company_members` com o papel do convite e marca `ACCEPTED`. Convite pode ser **revogado** e **expira**.

Ciclo de empresa: criada pelo Proprietário → **pendente** → **liberada pelo Administrador**. O Administrador também bloqueia empresas/usuários e libera recursos (`entitlements`).

**Toda operação sensível valida permissão no backend** (§33).

---

## 8. RLS (§23)

- RLS **ativa** em todas as tabelas multi-tenant, cobrindo `SELECT/INSERT/UPDATE/DELETE`.
- Funções auxiliares: `is_org_member(org)`, `has_company_access(company)`, `has_permission(perm, company)`, `is_owner(org)`, `is_platform_admin()`, `belongs_to_tenant(record)`.
- **Ouvintes (H3):** política por `EXISTS` sobre `listener_company_links` + `has_company_access`; dedup via `SECURITY DEFINER` que só devolve existência.
- **Funções `SECURITY DEFINER` (H2):** re-checam tenant + permissão internamente e auditam. Padrão obrigatório e coberto por teste.
- **Storage (N12):** buckets **privados**; políticas RLS em `storage.objects` restringindo por **prefixo de caminho por empresa** (`{company_id}/...`); nada de bucket público para documentos. Upload/download só pelo backend (ver N2).
- **Proibido** `USING (true)`. `organization_id`/`company_id` do cliente nunca aceitos sem checagem.
- Super-admin tem bypass **controlado e auditado** via `is_platform_admin()`, nunca via `service_role` exposto.

---

## 9. Segurança e LGPD (§8, §9)

Segurança: validação Zod + UUID; sanitização; proteção SQLi/XSS/CSRF; cookies seguros; headers + **CSP baseada em nonce** (Next.js); limite/validação de upload (tamanho, MIME, extensão); nomes de arquivo imprevisíveis; **URLs assinadas** para documentos privados; **rate limiting com store compartilhado** (N6); bloqueio de tentativas; logs de segurança; proteção contra enumeração de usuários; mensagens de erro sem detalhes internos; segredos só no servidor; env validado no boot; menor privilégio. Nunca expor `service_role`, segredos de webhook, tokens, credenciais, dados sensíveis, caminhos internos ou stack traces em produção.

LGPD:
- Minimização; finalidade; consentimento (data + origem); anonimização; exclusão lógica; retenção configurável; trilha de auditoria; controle de acesso a documentos; **registro de quem consultou dado sensível**; exportação do titular; anonimização do titular.
- **CPF/passaporte:** **hash normalizado** para dedup + últimos dígitos mascarados; imagem de documento **só em bucket privado**, acesso por empresa, log de visualização e retenção configurável (ideia #7).
- **Log por visualização de documento (N2):** a exigência "registrar quem visualizou" **não** é atendida por signed URL pura (reutilizável). Decisão: **downloads passam por um endpoint proxy do app** que (a) checa permissão, (b) grava `document_access_logs`, (c) faz stream do arquivo; a signed URL é interna, com **expiração curta**, nunca entregue direto ao cliente para documentos sensíveis.
- **Anonimização × auditoria imutável (N4):** `audit_logs` é imutável, mas não pode "ressuscitar" dado pessoal de um titular anonimizado. Política: para entidades com dado pessoal, os campos sensíveis são gravados na auditoria **mascarados/pseudonimizados** (ou como referência ao `listener_id`, não o valor cru). A anonimização do titular substitui os dados na tabela de origem; o histórico de auditoria mantém apenas a forma pseudonimizada. O **evento** de anonimização é auditado.
- **Retenção (N7):** **cron de retenção** (`pg_cron`) percorre documentos e dados de titular cujo prazo expirou e aplica exclusão/anonimização conforme a política por empresa. Idempotente, auditado, com alerta de falha.

---

## 10. Integrações (§32) — WhatsApp core no v1

Camada de integração **desacoplada**. Todo webhook: **valida assinatura → registra `webhook_events` → responde 200 rápido → processa assíncrono → registra falhas → permite reprocesso**. Preparado para WhatsApp Cloud API, IA, importação de mensagens, cadastro automático de ouvintes, intenção, pedido de música, APIs externas.

**M2 — Mecanismo assíncrono (decisão):**
- **Inbound:** o webhook persiste em `webhook_events` (`external_id` único = idempotência) e retorna 200. Um **worker** — Edge Function acionada por **`pg_cron`** em intervalo curto — consome eventos pendentes idempotentemente (`RECEIVED → PROCESSING → DONE/FAILED`), com retry/backoff e reprocesso manual.
- **Outbound:** `outbox_messages` drenado pelo mesmo worker.
- **Evolução:** trocar o polling por **`pgmq`** sem mudar o contrato do worker.

**Fluxo de ingestão WhatsApp (v1):** evento → dedup por `external_id` → identifica a promoção (por número/hashtag) → cria/associa ouvinte (dedup §4.5) → **cria participação com enforcement das regras (N3)** → parse de respostas do quiz.

**N3 — Regras de participação sob concorrência.** "Permite mais de uma participação", "limite por pessoa" e "intervalo mínimo entre participações" são validados **transacionalmente**, com **lock por `(promoção, ouvinte)`** (advisory lock ou `SELECT ... FOR UPDATE`) dentro da RPC que cria a participação, e reforçados por **constraint** (ex.: índice único parcial quando `permite_multipla = false`). Assim, mensagens quase simultâneas não furam o limite. Participações que violam a regra ficam `INVALID/DUPLICATE` com motivo.

---

## 11. Plano de desenvolvimento em blocos

**Cross-cutting obrigatório em todo bloco:** RLS nas tabelas novas · validação Zod · `audit_logs` das operações sensíveis · testes (unit/integração) · gate `lint` + `typecheck` + testes · atualização de docs.

**Testes de isolamento multi-tenant no CI (ideia #1, M3):** desde o Bloco 1, o harness **cria usuários de teste reais, faz login e usa o JWT do usuário** (nunca `service_role`) para afirmar que o acesso a dados de outra empresa **falha**, e que funções `SECURITY DEFINER` recusam quem não tem permissão. Ferramentas: **Vitest** (unit/serviço), **Playwright** (e2e), **pgTAP**/harness autenticado (RLS/DB) — N9.

### Bloco 0 — Fundação técnica
Next.js App Router + TS strict; Tailwind + shadcn/ui; Zod, RHF, TanStack Table/Query, Recharts, ExcelJS, `@react-pdf/renderer`; **Vitest + Playwright + pgTAP** (N9); interface `mailer` (SMTP/Resend — N10); interface de rate limit + `rate_limit_counters` (N6); Supabase CLI + migrations; **validação de env no boot**; dois clients Supabase (D4); taxonomia de erros (§25); logs estruturados + correlação; CI; Dockerfile.
**Pronto quando:** app sobe local e em CI; `lint`/`typecheck`/testes passam; env inválido barra o boot; dois clients documentados.

### Bloco 1 — Identidade & multi-tenant
Tabelas de identidade/tenant + **`invitations`** (N1); Supabase Auth (signup/login/logout/reset/confirm); **fluxo de convite/aceite** com token+expiração criando membership (N1); funções RLS; ciclo empresa (pendente → liberada); seletor de empresa + visão consolidada.
**Pronto quando:** criar conta → org → 2 empresas → **convidar/aceitar** → limitar a 1 empresa funciona; **teste de acesso cruzado (JWT de usuário) falha como esperado**; convite expira/revoga.

### Bloco 2 — Estoque & prêmios (núcleo crítico)
`prize_categories, prizes, inventory_movements` (ledger), `inventory_balances` + `promotion_prize_balances` (H1); funções RPC por movimento com idempotência/lock/`CHECK`, baldes e equação canônica (§5); reconciliação; UI de cadastro, visão contábil, movimentações, ajustes/reservas.
**Pronto quando:** invariantes (baldes ≥ 0, transições) cobertas por testes; saldo negativo impossível; reconciliação sem divergência no seed.

### Bloco 3 — Ouvintes
Tabelas de ouvinte; CRUD + filtros server-side + detalhes; bloqueio/espera/arquivar/anonimizar; dedup no escopo da org via `SECURITY DEFINER` (§4.5) + **índices únicos parciais** (N5); RLS por `listener_company_links`; LGPD (consentimento; documento via **proxy de download + `document_access_logs`** — N2; auditoria pseudonimizada — N4).
**Pronto quando:** dedup impede duplicidade **sem vazar ouvinte de outra empresa**; documento só acessível pelo proxy, com log por acesso; anonimização não deixa dado pessoal na auditoria.

### Bloco 4 — Promoções, quiz & participações
Tabelas de promoção/quiz/participação; abas; **vínculo de prêmio transacional** (RPC, usa Bloco 2 e projeção por promoção); máquina de estados; participação manual + importação; **enforcement de limite/intervalo por pessoa (N3)**.
**Pronto quando:** não vincula acima do disponível; não desvincula abaixo do sorteado; **limite/intervalo por pessoa não é furado sob concorrência**; estados inválidos bloqueados; importação idempotente.

### Bloco 5 — WhatsApp Cloud API
`integrations, webhook_events`, worker (`pg_cron`→Edge Function) e `outbox_messages` (M2); webhook com assinatura + idempotência + assíncrono + reprocesso; ingestão → dedup → ouvinte → participação (com N3) → respostas.
**Pronto quando:** evento repetido não duplica participação; assinatura inválida rejeitada; worker processa pendentes e permite reprocesso.

### Bloco 6 — Sorteios & entregas
Tabelas de sorteio/entrega/retorno com cadeia `promotion_prize_id` (M4); elegibilidade; sorteio CSPRNG auditável; **prazo congelado**; **promoção de suplente (N8)**; **flag permite-retorno (N11)**; entrega transacional idempotente; comprovante privado; retorno ao estoque; **cron de prazos** + notificação.
**Pronto quando:** prêmio não é entregue duas vezes; entrega decrementa a promoção correta; prazo vencido vira retorno pendente automaticamente; suplente pode ser promovido com estoque/prazo coerentes; retorno respeita o flag do prêmio.

### Bloco 7 — Músicas
Modelar domínio Músicas (§4.2); UI (dashboard, catálogos, categorias, pedidos, manutenção); migração do legado.
**Pronto quando:** pedidos musicais listáveis/filtráveis; dashboard de músicas com indicadores; dados legados migrados e conferidos.

### Bloco 8 — Dashboard & relatórios
3 dashboards (Ouvintes/Músicas/Promoções) com filtro empresa/período/consolidado (períodos no fuso da empresa — L2) e gráficos; consultas agregadas eficientes; relatórios com export Excel/CSV/PDF; **geração assíncrona p/ grandes**; `saved_reports`.
**Pronto quando:** indicadores da §12 batem com o seed; recortes de período conferem no fuso da empresa; relatório grande gera assíncrono sem travar o cliente.

### Bloco 9 — Migração do legado (ETL)
**Runtime (N13):** **script Node único e versionado** (`supabase/seed`/`scripts`), lê o SQL Server com `mssql` e grava no Supabase com `service_role`; roda fora da app (dev/ops), com log e re-execução idempotente. Migra ouvintes, promoções, prêmios/estoque (**saldo inicial via `INITIAL_ENTRY`**), músicas; reconciliação e relatório de divergências. *(Interliga com Blocos 3 e 7.)*
- **L1:** como o WhatsApp (Bloco 5) já pode ter criado ouvintes, o ETL **reconcilia por dedup** (telefone/e-mail/CPF-hash/passaporte no escopo da org): casa ou cria, nunca duplica; merge auditado.
**Pronto quando:** contagens origem×destino conferem; saldos iniciais batem; nenhum ouvinte duplicado após o merge; divergências reportadas.

### Bloco 10 — Administração completa
Console do Administrador (dono do App): liberar/bloquear empresas e usuários, liberar recursos (`entitlements`), config do webhook WhatsApp; admin da org: empresas, usuários, convites, funções/permissões, config por empresa, visor de auditoria.
**Pronto quando:** empresa pendente só opera após liberação; bloqueio de empresa/usuário efetivo; auditoria consultável.

### Bloco 11 — Qualidade, segurança & produção
E2E (fluxos §28); revisão de segurança (headers, **CSP com nonce**, rate-limit, upload/MIME); observabilidade (health, métricas, monitoramento de erros, **alerta de falha de cron/integração/retenção**); **cron de retenção (N7)** validado; docs (ARCHITECTURE/SECURITY/DATABASE/PERMISSIONS/DEPLOYMENT); seed controlado; deploy (Docker + Vercel/Supabase; backup/PITR documentado).
**Pronto quando:** E2E do §35 passam ponta a ponta; documentação entregue; deploy reproduzível.

---

## 12. Ideias incorporadas (além da spec)

1. Auditoria + **testes de isolamento como gate de CI** desde o Bloco 1 (com JWT — M3).
2. `idempotency_keys` **genérica** (Server Actions + webhooks).
3. **Reconciliação** das duas projeções ledger↔saldo com alerta.
4. **Entitlements** por empresa (base p/ faturamento futuro).
5. **Outbox pattern** para saídas confiáveis.
6. **Máquinas de estado explícitas** (promoção, participação, prêmio sorteado).
7. **CPF/documento:** hash normalizado + máscara; imagem só em bucket privado.
8. **shadcn/ui** no lugar de Bootstrap.

---

## 13. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| v1 amplo (prêmios + WhatsApp + Músicas + migração) | Sequenciamento núcleo-primeiro; fatia vertical cedo; DoD por bloco. |
| Correção de estoque sob concorrência | Ledger + duas projeções + RPC PL/pgSQL com lock + testes pesados no Bloco 2. |
| Compromisso de prêmio por promoção mal rastreado (H1) | Projeção `promotion_prize_balances` + invariante "não desvincular abaixo do sorteado". |
| Furar limite de participação sob concorrência (N3) | Lock por `(promoção, ouvinte)` + constraint na RPC de participação. |
| Vazamento entre tenants / ouvinte compartilhado (H3) | RLS por `listener_company_links`; dedup `SECURITY DEFINER`; testes de isolamento com JWT. |
| Dado sensível vazando por URL/auditoria (N2/N4) | Proxy de download + `document_access_logs`; auditoria pseudonimizada. |
| `service_role` bypassar RLS por engano | Client de sistema isolado; funções `SECURITY DEFINER` re-autorizam (H2). |
| Migração legada inconsistente / duplicidade com WhatsApp (L1) | Reconciliação por dedup no ETL + relatório de divergências (Bloco 9). |
| Custos/latência de IA e WhatsApp | Camada desacoplada + outbox + worker assíncrono (M2). |

---

## 14. Critérios de aceitação do v1 (§35)

Fluxo ponta a ponta com segurança multi-tenant: criar conta → organização → 2 empresas → convidar usuário limitado a 1 empresa → cadastrar ouvintes por empresa → **impedir acesso cruzado** → cadastrar prêmios → adicionar estoque → reservar → criar promoção → vincular prêmios (**impedir vínculo acima do saldo**) → registrar participação → sortear → criar ganhador → registrar prazo → entregar com **comprovante privado** → atualizar estoque corretamente → processar prêmio não retirado → retornar ao estoque → gerar relatório → exportar → registrar auditoria.

---

## 15. Próximos passos

1. Revisão deste documento pelo proprietário.
2. Geração do **plano de implementação** (skill `writing-plans`), começando pelo **Bloco 0**.
3. Cada bloco: implementar → `lint`/`typecheck`/testes → revisão de segurança → documentar concluído/pendências → só então avançar (§34).

---

## 16. Changelog

- **rev2 (2026-07-26)** — 2ª passada de revisão (completude/segurança/LGPD):
  - **N1:** tabela + fluxo de `invitations` (convite/aceite/expiração/revogação). §4.1, §4.3, §7, Bloco 1.
  - **N2:** log por visualização via **proxy de download** + `document_access_logs` (signed URL pura não basta). §4.3, §9, Bloco 3.
  - **N3:** enforcement transacional de limite/intervalo de participação (lock por promoção+ouvinte). §10, Bloco 4.
  - **N4:** anonimização × auditoria imutável — campos sensíveis pseudonimizados na auditoria. §9, Bloco 3.
  - **N5:** índices únicos **parciais** (`WHERE deleted_at IS NULL`). §4.4.
  - **N6:** rate limiting com store compartilhado (`rate_limit_counters` no Postgres / Upstash). §3.1, §9, Bloco 0.
  - **N7:** **cron de retenção** LGPD. §9, Bloco 11.
  - **N8:** fluxo de **promoção de suplente** a ganhador. §6, Bloco 6.
  - **N9:** stack de testes definida (Vitest + Playwright + pgTAP/harness). §3.1, §11, Bloco 0.
  - **N10:** provedor de e-mail do app (`mailer` SMTP/Resend). §3.1, §4.1.
  - **N11:** flag `permite_retorno_ao_estoque` gateia `RETURN_TO_STOCK` vs `WRITE_OFF`. §6.
  - **N12:** políticas RLS do Storage por prefixo de empresa. §8.
  - **N13:** runtime do ETL (script Node com `mssql` + `service_role`). Bloco 9.
- **rev1 (2026-07-26)** — 1ª passada: H1–H3, M1–M5, L1–L3.
- **rev0 (2026-07-25)** — Versão inicial aprovada (decisões D1–D5, plano em blocos 0–11).
