# CRM Multi-Tenant para Rádios — Documento de Design (v1)

- **Data:** 2026-07-25
- **Status:** Aprovado para plano de implementação
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
- **Gráficos:** Recharts. **Datas:** date-fns (+ date-fns-tz). **Export:** ExcelJS (Excel), CSV nativo, gerador de PDF confiável (ex.: `@react-pdf/renderer` ou `pdfmake`).
- **Banco/infra:** Supabase (PostgreSQL, Auth, Storage, RLS, migrations, funções PL/pgSQL, `pg_cron`, Edge Functions e Realtime **só onde agregam valor**).
- **Deploy:** Dockerfile completo + alvo Vercel (app) + Supabase gerenciado. Camada de armazenamento e integrações **desacopladas** para não acoplar a um único provedor.

### 3.2 Camadas (por feature)

```
UI (Server/Client Components)
  → Server Actions / API Routes  (autenticação + orquestração)
    → services/       (regra de negócio, autorização granular, transações)
      → repositories/ (acesso a dados, queries, RLS via client do usuário)
        → PostgreSQL / funções PL/pgSQL (invariantes críticas: estoque, sorteio)
schemas/  (Zod)   permissions/  (RBAC)   audit/  (trilha)   lib/integrations/ (desacoplada)
```

Regras: sem lógica de negócio dentro de componentes React; sem duplicação de regra em múltiplos lugares; arquivos focados (um propósito claro por unidade).

### 3.3 Dois clients Supabase (decisão D4)

- **Client de usuário (padrão):** criado por requisição com o **JWT/sessão do usuário**. Toda leitura/escrita de dados de tenant passa por ele → **RLS é aplicada de fato**.
- **Client de sistema (`service_role`, isolado):** usado **somente** em: webhook do WhatsApp, jobs de cron, ETL de migração e operações de plataforma. Nunca exposto ao cliente; nunca usado para atender request de usuário comum.

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

Identidade/tenant: `profiles, organizations, organization_members, companies, company_members, roles, permissions, role_permissions, member_roles`.

Ouvintes: `listeners, listener_company_links, listener_consents, listener_notes, listener_documents, listener_blocks`.

Prêmios/estoque: `prize_categories, prizes, inventory_locations, inventory_movements, inventory_balances`.

Promoções: `promotions, promotion_whatsapp_settings, promotion_requested_fields, promotion_questions, promotion_question_options, promotion_prizes`.

Participações/sorteio/entrega: `participations, participation_answers, draws, draw_entries, winners, winner_status_history, deliveries, delivery_documents, return_cases, return_case_history`.

Infra: `files, integrations, webhook_events, notifications, audit_logs, saved_reports`.

### 4.2 Domínio Músicas — **novo** (gap da §22, decisão D3)

Todas com `organization_id` + `company_id` + timestamps + soft delete:

- `music_genres` — categorias/gêneros de música. *(legado: derivado de `catalog_medias`)*
- `record_labels` — gravadoras. *(legado: `Cad_Gravadoras`)*
- `artists` — artistas/intérpretes. *(legado: `catalog_artists`)*
- `songs` (mídias) — título, `artist_id`, `label_id`, `genre_id`, **nacionalidade** (nacional/internacional), **gênero vocal** (masculina/feminina), duração, código interno, status. *(legado: `catalog_medias`)*
- `radio_shows` — programas da rádio. *(legado: `listener_shows`)*
- `music_requests` (pedidos musicais) — `listener_id`, `song_id`, `show_id`, canal/origem, `requested_at`, status. *(legado: `ouvintes_ped_musica`)*

Estes indicadores alimentam o **Dashboard de Músicas** (total, novas no período, mais pedida, categoria mais pedida, nacional/internacional, masculina/feminina).

### 4.3 Tabelas adicionais — **ideias incorporadas**

- `idempotency_keys` — chave genérica reutilizável para Server Actions sensíveis (entrega, vínculo) além de webhooks (ideia #2).
- `entitlements` — recursos/limites contratados por empresa; base para o "Administrador libera recursos" e faturamento futuro (ideia #4).
- `outbox_messages` — outbox para saídas confiáveis (WhatsApp/IA/webhooks de saída) com reprocesso (ideia #5).
- `platform_admins` — vínculo de usuários que são **Administrador (dono do App)**, cross-tenant.

### 4.4 Convenções de schema

UUID em PKs; `timestamptz` (armazenar em UTC, exibir no fuso da empresa); FKs, checks, unicidade e índices explícitos; **soft delete** (`deleted_at`), status e anonimização em vez de exclusão física; versionamento otimista onde necessário. Índices compostos por `organization_id`, `company_id`, `status`, datas, promoção, ouvinte, prêmio, **telefone normalizado** e **documento normalizado (hash)** — cada índice documentado (§22).

---

## 5. Regras de estoque (núcleo crítico)

Modelo **ledger + projeção** (§14.2–14.3, §24):

- `inventory_movements` = **ledger imutável**. Nunca editar/excluir; correção só por novo movimento.
- `inventory_balances` = **projeção transacional confiável** (não contadores editáveis livremente), mantida dentro da mesma transação do movimento.
- **Tipos de movimento:** `INITIAL_ENTRY, PURCHASE_ENTRY, MANUAL_ENTRY, MANUAL_EXIT, RESERVATION, RESERVATION_RELEASE, PROMOTION_LINK, PROMOTION_UNLINK, DRAW, DRAW_CANCEL, DELIVERY, RETURN_PENDING, RETURN_TO_STOCK, WRITE_OFF, ADJUSTMENT_POSITIVE, ADJUSTMENT_NEGATIVE, TRANSFER_IN, TRANSFER_OUT`.
- **Situações do saldo:** estoque físico, disponível, reservado, vinculado, sorteado, aguardando retirada, entregue, retorno pendente, retornado ao estoque, baixado, estoque utilizável.

**Invariantes (validadas em transação + CHECK):**
- disponível nunca negativo;
- não vincular quantidade > disponível;
- não sortear quantidade > vinculada disponível;
- não entregar quantidade não sorteada;
- não desvincular abaixo do já comprometido/sorteado;
- não entregar o mesmo prêmio duas vezes (idempotência).

Toda operação de estoque roda em **função PL/pgSQL transacional** com **lock adequado** (`SELECT ... FOR UPDATE` na linha de saldo) + **chave de idempotência** + registro em `audit_logs`.

**Job de reconciliação** (ideia #3): recalcula `balances` a partir do ledger periodicamente e alerta divergências.

---

## 6. Sorteio, prazo e entrega

- **Sorteio** (§17): elegibilidade validada (exclui bloqueado), método manual ou aleatório com **fonte criptograficamente segura (CSPRNG)** ou processo reproduzível/auditável; registra participantes elegíveis, parâmetros, ganhadores, suplentes e evidência de auditoria; permite cancelar/refazer com justificativa.
- **Efeito do sorteio no estoque:** sai de "vinculado" → "aguardando retirada", associa ao ouvinte, gera movimento `DRAW`, impede dupla atribuição.
- **Prazo de retirada** (§18): **congelado no momento do sorteio** (não depender do cadastro atual do prêmio). Prêmio pode ter prazo padrão; promoção pode sobrescrever.
- **Cron idempotente** (`pg_cron` + Edge Function): processa prazos vencidos → `RETURN_PENDING` + notifica; permite prorrogar/retornar/baixar. Falha de cron gera alerta (§31).
- **Entrega** (§13.4): fluxo transacional idempotente com localizar ouvinte → conferir → responsável/documento mascarado → **comprovante em bucket privado** → confirmar → movimento `DELIVERY` → auditoria → comprovante.

---

## 7. RBAC e permissões (§7)

Papéis: **Proprietário** (dono da organização), **Operador**, **Consulta**, e **Administrador = dono do App** (super-admin cross-tenant, via `platform_admins` / `is_platform_admin()`).

Papéis e permissões são **dados** (`roles, permissions, role_permissions, member_roles`), permitindo granularidade por empresa. Permissões granulares (ex.: `listeners.create`, `inventory.reserve`, `promotions.publish`, `deliveries.execute`, `reports.export`, `users.invite`, `companies.manage`) + uma permissão específica **`reports.consolidated`** para visão consolidada de várias empresas.

Ciclo de empresa: criada pelo Proprietário → **pendente** → **liberada pelo Administrador**. O Administrador também bloqueia empresas/usuários e libera recursos (`entitlements`).

**Toda operação sensível valida permissão no backend** (§33).

---

## 8. RLS (§23)

- RLS **ativa** em todas as tabelas multi-tenant, cobrindo `SELECT/INSERT/UPDATE/DELETE`.
- Funções auxiliares seguras: `is_org_member(org)`, `has_company_access(company)`, `has_permission(perm, company)`, `is_owner(org)`, `is_platform_admin()`, `belongs_to_tenant(record)`.
- **Proibido** `USING (true)`. `organization_id`/`company_id` vindos do cliente nunca são aceitos sem checagem de acesso.
- Super-admin (Administrador) tem bypass **controlado e auditado** via `is_platform_admin()`, nunca via `service_role` exposto.

---

## 9. Segurança e LGPD (§8, §9)

Segurança: validação Zod + UUID; sanitização; proteção SQLi/XSS/CSRF; cookies seguros; headers + CSP; limite/validação de upload (tamanho, MIME, extensão); nomes de arquivo imprevisíveis; **URLs assinadas** para documentos privados; rate limiting; bloqueio de tentativas; logs de segurança; proteção contra enumeração de usuários; mensagens de erro sem detalhes internos; segredos só no servidor; env validado no boot; menor privilégio. Nunca expor `service_role`, segredos de webhook, tokens, credenciais, dados sensíveis, caminhos internos ou stack traces em produção.

LGPD: minimização; finalidade; consentimento (data + origem); anonimização; exclusão lógica; retenção configurável; trilha de auditoria; controle de acesso a documentos; **registro de quem consultou dado sensível**; exportação do titular; anonimização do titular. **CPF/passaporte:** armazenar **hash normalizado** para dedup + últimos dígitos mascarados; imagem de documento **só em bucket privado** com URL assinada, acesso por empresa, log de visualização e retenção configurável (ideia #7).

---

## 10. Integrações (§32) — WhatsApp core no v1

Camada de integração **desacoplada** (sem misturar WhatsApp com telas ou regras de estoque). Todo webhook: **valida assinatura → registra `webhook_events` → idempotência → processa assíncrono → registra falhas → permite reprocesso**. Saídas via **outbox**. Preparado para WhatsApp Cloud API, IA, importação de mensagens, cadastro automático de ouvintes, intenção, pedido de música, APIs externas.

Fluxo de ingestão WhatsApp (v1): evento → dedup por identificador externo → cria/associa ouvinte → cria participação (idempotente) → parse de respostas do quiz.

---

## 11. Plano de desenvolvimento em blocos

**Cross-cutting obrigatório em todo bloco:** RLS nas tabelas novas · validação Zod · `audit_logs` das operações sensíveis · testes (unit/integração) · gate `lint` + `typecheck` + testes · atualização de docs. **Testes de isolamento multi-tenant no CI** (tentar acessar dado de outra empresa e esperar falha) desde o Bloco 1 (ideia #1).

### Bloco 0 — Fundação técnica
Next.js App Router + TS strict; Tailwind + shadcn/ui; Zod, RHF, TanStack Table/Query, Recharts, ExcelJS/PDF; Supabase CLI + pipeline de migrations; **validação de env no boot**; dois clients Supabase (D4); taxonomia de erros (§25); logs estruturados + correlação; CI; Dockerfile.
**Pronto quando:** app sobe local e em CI; `lint`/`typecheck`/testes passam; env inválido barra o boot; dois clients documentados.

### Bloco 1 — Identidade & multi-tenant
Tabelas de identidade/tenant; Supabase Auth (signup/login/logout/reset/confirm/convite/aceite/status); funções RLS; ciclo empresa (pendente → liberada); seletor de empresa + visão consolidada.
**Pronto quando:** fluxo criar conta → org → 2 empresas → convidar usuário → limitar a 1 empresa funciona; **teste de acesso cruzado falha como esperado**.

### Bloco 2 — Estoque & prêmios (núcleo crítico)
`prize_categories, prizes, inventory_movements` (ledger), `inventory_balances` (projeção); funções PL/pgSQL por movimento com idempotência/lock/CHECK; reconciliação; UI de cadastro, visão contábil, movimentações, ajustes/reservas.
**Pronto quando:** invariantes de saldo cobertas por testes; saldo negativo impossível; reconciliação sem divergência no seed.

### Bloco 3 — Ouvintes
Tabelas de ouvinte; CRUD + filtros server-side + detalhes; bloqueio/espera/arquivar/anonimizar; dedup (telefone/e-mail/CPF/passaporte, único por org); LGPD (consentimento + documento privado + log de visualização).
**Pronto quando:** dedup impede duplicidade silenciosa; documento só acessível por URL assinada com log; anonimização funciona.

### Bloco 4 — Promoções, quiz & participações
Tabelas de promoção/quiz/participação; abas (Promoção/WhatsApp/Quiz/Prêmios); **vínculo de prêmio transacional** (usa Bloco 2); máquina de estados; participação manual + importação.
**Pronto quando:** não é possível vincular acima do disponível; estados inválidos bloqueados; participação importada é idempotente.

### Bloco 5 — WhatsApp Cloud API
`integrations, webhook_events`; webhook com assinatura + idempotência + assíncrono + reprocesso; ingestão → dedup → ouvinte → participação → respostas; camada desacoplada + outbox.
**Pronto quando:** evento externo repetido não duplica participação; assinatura inválida rejeitada; reprocesso controlado disponível.

### Bloco 6 — Sorteios & entregas
Tabelas de sorteio/entrega/retorno; elegibilidade; sorteio CSPRNG auditável; **prazo congelado**; entrega transacional idempotente; comprovante privado; retorno ao estoque; **cron de prazos vencidos** + notificação.
**Pronto quando:** prêmio não é entregue duas vezes; prazo vencido vira retorno pendente automaticamente; retorno gera movimento e reabastece disponível.

### Bloco 7 — Músicas
Modelar domínio Músicas (§4.2); UI (dashboard, catálogos, categorias, pedidos, manutenção); migração do legado.
**Pronto quando:** pedidos musicais listáveis/filtráveis; dashboard de músicas com indicadores; dados legados migrados e conferidos.

### Bloco 8 — Dashboard & relatórios
3 dashboards (Ouvintes/Músicas/Promoções) com filtro empresa/período/consolidado e gráficos; consultas agregadas eficientes; relatórios com export Excel/CSV/PDF; **geração assíncrona p/ grandes**; `saved_reports`.
**Pronto quando:** indicadores da §12 batem com o seed; relatório grande gera assíncrono sem travar o cliente.

### Bloco 9 — Migração do legado (ETL)
ETL SQL Server → Supabase: ouvintes, promoções, prêmios/estoque (**saldo inicial via `INITIAL_ENTRY`**), músicas; reconciliação e relatório de divergências. *(Interliga com Blocos 3 e 7.)*
**Pronto quando:** contagens origem×destino conferem; saldos iniciais batem com o legado; divergências reportadas.

### Bloco 10 — Administração completa
Console do Administrador (dono do App): liberar/bloquear empresas e usuários, liberar recursos (`entitlements`), config do webhook WhatsApp; admin da org: empresas, usuários, convites, funções/permissões, config por empresa, visor de auditoria.
**Pronto quando:** empresa pendente só opera após liberação; bloqueio de empresa/usuário efetivo; auditoria consultável.

### Bloco 11 — Qualidade, segurança & produção
E2E (fluxos §28); revisão de segurança (headers, CSP, rate-limit, upload/MIME); observabilidade (health, métricas, alerta de falha de cron/integração); docs (ARCHITECTURE/SECURITY/DATABASE/PERMISSIONS/DEPLOYMENT); seed controlado; deploy (Docker + Vercel/Supabase).
**Pronto quando:** E2E do §35 passam ponta a ponta; documentação entregue; deploy reproduzível.

---

## 12. Ideias incorporadas (além da spec)

1. Auditoria + **testes de isolamento como gate de CI** desde o Bloco 1.
2. `idempotency_keys` **genérica** (Server Actions + webhooks).
3. **Reconciliação de saldos** ledger↔projeção com alerta.
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
| Correção de estoque sob concorrência | Ledger + projeção + funções PL/pgSQL com lock + testes pesados no Bloco 2. |
| Vazamento entre tenants | RLS + serviço (D4) + testes de isolamento no CI. |
| `service_role` bypassar RLS por engano | Client de sistema isolado, usado só em webhook/cron/ETL/plataforma. |
| Migração legada inconsistente | Reconciliação origem×destino + relatório de divergências (Bloco 9). |
| Custos/latência de IA e WhatsApp | Camada desacoplada + outbox + processamento assíncrono. |

---

## 14. Critérios de aceitação do v1 (§35)

Fluxo ponta a ponta funcionando com segurança multi-tenant: criar conta → organização → 2 empresas → convidar usuário limitado a 1 empresa → cadastrar ouvintes por empresa → **impedir acesso cruzado** → cadastrar prêmios → adicionar estoque → reservar → criar promoção → vincular prêmios (**impedir vínculo acima do saldo**) → registrar participação → sortear → criar ganhador → registrar prazo → entregar com **comprovante privado** → atualizar estoque corretamente → processar prêmio não retirado → retornar ao estoque → gerar relatório → exportar → registrar auditoria.

---

## 15. Próximos passos

1. Revisão deste documento pelo proprietário.
2. Geração do **plano de implementação** (skill `writing-plans`), começando pelo **Bloco 0**.
3. Cada bloco: implementar → `lint`/`typecheck`/testes → revisão de segurança → documentar concluído/pendências → só então avançar (§34).
