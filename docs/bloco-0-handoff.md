# Bloco 0 → Bloco 1 — Handoff

Fecha a branch `bloco-0-fundacao` (29 commits, `a8a7109..577ab67`). Tudo abaixo foi
verificado por execução real, não por inspeção. Itens marcados **(decidido)** já
passaram por decisão humana — não relitigar.

## Pode construir em cima com confiança

- **Isolamento do `service_role`** — `src/lib/supabase/service-client.ts` está marcado
  `server-only`, e a ausência de `SUPABASE_SERVICE_ROLE_KEY`/`createServiceClient` no
  bundle compilado (`.next/static`) foi conferida por grep. A garantia é real.
- **Validação de ambiente no boot** — `src/instrumentation.ts` valida e **encerra o
  processo com exit 1** se o ambiente for inválido. Comprovado no artefato standalone
  (o mesmo binário que o `CMD` do container roda): sem env → exit 1; com env → HTTP 200.
- **Rate limiter** — as semânticas de saturação das duas implementações concordam
  valor a valor, comprovado executando a RPC no banco real e comparando com os testes
  unitários. `rate_limit_hit` é atômica (upsert de statement único).
- **Taxonomia de erros** — `toSafeJSON` comprovadamente não vaza `cause` nem stack.
- **Pipeline de migrations + pgTAP** — `db:reset` e `db:test` (7 asserts) rodam de
  verdade. O smoke executa a RPC e verifica que `anon` continua sem DML.

## Precisa resolver logo no Bloco 1

1. **`middleware.ts` não existe.** `src/lib/supabase/user-client.ts` engole falhas de
   escrita de cookie por design, assumindo que o middleware renova a sessão. Sem ele,
   sessões expiram silenciosamente. **Item #1 da tarefa de auth.**
2. **Redação do logger vs. Supabase.** Os campos `access_token`/`refresh_token` já são
   redigidos, mas confira o formato real do objeto de sessão quando integrar o auth —
   `MAX_DEPTH = 8` em `src/lib/logger.ts` e chaves mais fundas passam sem redação.
3. **Tipos `Database` não existem.** Os dois clients retornam `SupabaseClient` cru, então
   `.from()` e `.rpc()` são destipados — foi exatamente assim que um `any` de biblioteca
   burlou o `noUncheckedIndexedAccess` no Bloco 0. Rode `supabase gen types typescript`
   cedo e passe o genérico nos dois factories; fica muito mais barato antes do schema crescer.
4. **`env` validado não tem consumidores.** `src/lib/supabase/config.ts` lê `process.env`
   direto **(decidido — para o teste poder mutar)**. O boot valida, mas o objeto tipado não
   é usado por ninguém. Ligar consumidores ao `env` faz o `Env | LooseEnv` valer a pena.
5. **shadcn/ui** — a camada de tokens (CSS vars slate + `theme.extend.colors`) já foi
   shipada, então `npx shadcn add` funciona. O bloco `.dark` só entra no CSS compilado
   quando existir uma classe `dark` no `content`.

## Dívida registrada (não bloqueia, mas não redescubra)

| Item | Onde |
|---|---|
| `register()` cobre só `nodejs`; sem `HEALTHCHECK` no Dockerfile | `src/instrumentation.ts`, `Dockerfile` |
| Cycle-guard do logger devolve o objeto original por referência — ciclos reais vazam um nível **(decidido: adiado)** | `src/lib/logger.ts:59-63` |
| Upload de artefato do Playwright é inerte (nenhum `reporter` configurado) **(decidido: adiado)** | `.github/workflows/ci.yml`, `playwright.config.ts` |
| `prettier --check .` falha em 6 arquivos, e nenhum step de CI roda prettier | repo-wide |
| Configs da raiz seguem sem lint — `--dir` **substitui** os defaults; só a migração pro ESLint CLI fecha isso | `package.json`, `.eslintrc.json` |
| `next lint` é deprecado e some no Next 16 | `package.json` |
| `EBADENGINE`: seis `@supabase/*` querem Node ≥ 22, CI fixa 20 | `.github/workflows/ci.yml` |
| GitHub deprecou Node 20 nas actions — `checkout@v4`, `setup-node@v4` e `supabase/setup-cli@v1` já rodam forçadas em Node 24. Só aviso; decide junto com o item acima | `.github/workflows/ci.yml` |
| `SmtpMailer` e `PostgresRateLimiter` sem teste unitário **(decidido)** | `src/lib/mailer`, `src/lib/rate-limit` |
| `PostgresRateLimiter` aceita qualquer client — exigir o service client é só documentação | `src/lib/rate-limit/index.ts` |
| `config.toml`: `site_url` http vs `additional_redirect_urls` https — importa ao ligar auth | `supabase/config.toml` |
| Numeração de migrations `0001`/`0002` vs. timestamp do `supabase migration new` — escolher uma | `supabase/migrations/` |
| Bloco do `package.json` no plano omite a devDep `supabase` | `docs/superpowers/plans/2026-07-26-bloco-0-fundacao-tecnica.md` |

## Defeitos do plano corrigidos durante a execução

O documento do plano foi corrigido junto do código nas quatro vezes, então ele não
reproduz mais nenhum destes. Registrado porque o padrão importa: **código escrito em
plano não é código verificado.**

- `SmtpMailer` construía o transport a partir de `undefined` (falhava o `typecheck`).
- `rate_limit_counters` subia com RLS desligada — qualquer portador da anon key apagava
  os contadores.
- `service_role` não tinha DML na tabela: a `PostgresRateLimiter` lançava em **toda**
  chamada. Falha dependente de ambiente — passaria num projeto hospedado permissivo.
- O Dockerfile copiava `public/`, que não existia — `docker build` quebrava direto.
- `.dockerignore` não excluía `.env*`, com `.env.example` carregando
  `SUPABASE_SERVICE_ROLE_KEY`.

## Estado da CI

O workflow **nunca rodou no GitHub** — a branch acabou de ser publicada. A sequência
`lint → typecheck → test → build` foi verificada localmente dentro de `node:20-alpine`
(Node 20 + Linux, igual ao runner). Os jobs `db` e `e2e` são novos e só foram validados
sintaticamente. **Observe a primeira execução real** — em especial se o
`supabase/setup-cli` e o `@supabase/cli-linux-x64` instalam limpo no `ubuntu-latest`.
