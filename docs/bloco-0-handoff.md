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

## Deploy — EasyPanel (Hostinger VPS) e Supabase hospedado

Escrito na branch `deploy-readiness`. O registro completo, com a saída verbatim de
cada verificação, está em [`deploy-readiness-report.md`](./deploy-readiness-report.md).

### O contêiner precisa escutar em `0.0.0.0` — e não escutava

O entrypoint standalone do Next é gerado com
`const hostname = process.env.HOSTNAME || '0.0.0.0'`, e o **Docker sempre injeta
`HOSTNAME`** com o ID do contêiner. Resultado: o `||` nunca dispara e o processo
escuta só no IP para o qual aquele hostname resolve. Nunca `0.0.0.0`, nunca
`127.0.0.1`.

Um `docker run -p 3000:3000` numa rede só **não revela o bug** — o IP do contêiner
é justamente o publicado, então passa dos dois jeitos. Atrás do EasyPanel o
contêiner entra em **duas** redes (a do serviço e a do proxy Traefik), e o proxy
pode acertar a interface sem listener → 502 intermitente. Health check em
`localhost` também nunca funcionaria.

Correção: `ENV HOSTNAME=0.0.0.0` no estágio runner do `Dockerfile` — o `ENV` da
imagem tem precedência sobre o valor injetado pelo daemon.

### Health check

`src/app/api/health/route.ts` responde 200 com um JSON mínimo e é
`dynamic = 'force-dynamic'` (sem isso o Next otimizaria a rota estaticamente no
build e o check mediria um arquivo, não o processo). O `HEALTHCHECK` do Dockerfile
a consome via `wget` do BusyBox, presente na `node:22-alpine`.

**A rota não toca no banco de propósito.** Health check que consulta o Supabase
transforma oscilação de banco em restart de contêiner: o app continua vivo e capaz
de servir páginas, então derrubá-lo só amplifica o incidente. Configuração inválida
já é pega no boot pelo `src/instrumentation.ts`, que sai com exit 1 — um contêiner
mal configurado nem chega a responder aqui.

### Variáveis: o que é build-time e o que é runtime

O EasyPanel tem **duas** abas distintas, e a diferença não é cosmética:

| Variável | Onde vai | Por quê |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Build args** *e* Environment | `NEXT_PUBLIC_*` são inlined no bundle do cliente durante o `next build`. Definir só em Environment não altera um bundle já compilado — o valor nunca chega ao browser. O `Dockerfile` declara as duas como `ARG` no estágio builder. Também precisam existir em runtime, para o código de servidor. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Build args** *e* Environment | idem |
| `SUPABASE_SERVICE_ROLE_KEY` | **Somente Environment (runtime)** | Build args ficam gravados nas camadas da imagem. Passar o service role como `ARG` vaza o segredo para qualquer um que dê `docker history` na imagem. |
| `SMTP_URL`, `MAIL_FROM` | Environment (runtime) | opcionais |

> **`SKIP_ENV_VALIDATION` NUNCA pode aparecer no Environment do EasyPanel.**
> Ela existe só dentro do estágio builder do `Dockerfile`, porque durante o
> `next build` os segredos legitimamente não existem. Se vazar para o runtime,
> `src/lib/env.ts` cai no ramo frouxo (`parseLooseEnv`), a validação de boot
> **desaparece em silêncio** e o contêiner sobe sem nenhuma configuração de
> Supabase — falhando na primeira query, em produção, em vez de falhar no boot.
> É a diferença entre um deploy que quebra na hora e um que quebra na frente do
> cliente.

### `supabase config push` — não rode

`supabase/config.toml` é arquivo de **desenvolvimento local**. Empurrá-lo para o
projeto hospedado sobrescreve a configuração de produção com valores de dev:

- `site_url = "http://127.0.0.1:3000"` — quebra todo link de e-mail de auth;
- `additional_redirect_urls = ["https://127.0.0.1:3000"]` — idem;
- `[auth.email] enable_confirmations = false` — passa a aceitar cadastro sem
  confirmar e-mail;
- `minimum_password_length = 6` — afrouxa a política de senha;
- `[auth.rate_limit] email_sent = 2` — 2 e-mails por hora **no projeto inteiro**.

**Procedimento correto:**

```bash
supabase link --project-ref <ref>
supabase db push                 # aplica só as migrations
```

Site URL e Redirect URLs se configuram **no dashboard do Supabase**
(Authentication → URL Configuration), não pelo `config.toml`.

Dois detalhes que mordem:

- `major_version = 17` no `config.toml` precisa bater com a versão do projeto
  hospedado. Confira com `SHOW server_version;` no banco remoto antes do `link`;
  divergência faz o `db push` e o `db diff` se comportarem de forma imprevisível.
- **`supabase db reset --linked` é destrutivo** — dropa e recria o banco
  *hospedado*. Não use. `db:reset` local (`npm run db:reset`) é seguro porque age
  no stack do Docker; a flag `--linked` muda o alvo.

### Convenção de GRANT — leia antes de criar tabela

O mesmo defeito de permissão pegou `rate_limit_counters` **duas vezes numa única
sessão**: primeiro RLS desligada, depois `service_role` sem DML. A causa raiz é um
default da plataforma, não descuido: **tabela nova no schema `public` não recebe
GRANT de DML** para as roles do Supabase (o ACL padrão dá só `Dxtm` —
TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). E `BYPASSRLS` **não substitui um GRANT
ausente**: a role atravessa as policies, mas continua barrada no privilégio da
tabela quando a função é `SECURITY INVOKER`.

A regra, então:

> **Toda tabela nova acessada diretamente via `createServiceClient()` precisa de um
> `grant ... to service_role` explícito na própria migração.**

RPCs `SECURITY DEFINER` escapam disso porque rodam com os privilégios do dono da
função — mas aí o cuidado migra para o `search_path` fixado. `rate_limit_hit` é
`SECURITY INVOKER` de propósito, e é justamente por isso que a migração `0002`
carrega o `grant` explícito. O smoke pgTAP prova o GRANT executando a RPC sob a
role real (`set local role service_role`); existência de tabela não prova nada.

### `digest()` mora em `extensions`

`pgcrypto` já vem instalada no schema `extensions` (local **e** hospedado), então
`create extension if not exists pgcrypto;` era no-op. A `0001` agora declara
`with schema extensions` e registra o que importa na prática: dentro de função com
`set search_path = pg_catalog, public`, `digest()` **não resolve** — tem que ser
`extensions.digest(...)`. Vale para a função de hash de documento do Bloco 1.

## Dívida registrada (não bloqueia, mas não redescubra)

| Item | Onde |
|---|---|
| `register()` cobre só o runtime `nodejs` (o edge runtime sobe sem validação de env) | `src/instrumentation.ts` |
| Cycle-guard do logger devolve o objeto original por referência — ciclos reais vazam um nível **(decidido: adiado)** | `src/lib/logger.ts:59-63` |
| Upload de artefato do Playwright é inerte (nenhum `reporter` configurado) **(decidido: adiado)** | `.github/workflows/ci.yml`, `playwright.config.ts` |
| `prettier --check .` falha em 6 arquivos, e nenhum step de CI roda prettier | repo-wide |
| Configs da raiz seguem sem lint — `--dir` **substitui** os defaults; só a migração pro ESLint CLI fecha isso | `package.json`, `.eslintrc.json` |
| `next lint` é deprecado e some no Next 16 | `package.json` |
| ~~`EBADENGINE`: seis `@supabase/*` querem Node ≥ 22, CI fixa 20~~ **resolvido na `deploy-readiness`**: Dockerfile (3 estágios), `engines.node` e os jobs da CI foram para 22 | — |
| ~~GitHub deprecou Node 20 nas actions~~ **resolvido junto**: `node-version: 22` nos jobs `build` e `e2e` (o job `db` não usa Node — roda pela `supabase/setup-cli`) | — |
| `SmtpMailer` e `PostgresRateLimiter` sem teste unitário **(decidido)** | `src/lib/mailer`, `src/lib/rate-limit` |
| `PostgresRateLimiter` aceita qualquer client — exigir o service client é só documentação | `src/lib/rate-limit/index.ts` |
| `config.toml`: `site_url` http vs `additional_redirect_urls` https — importa ao ligar auth. Só vale para o dev local; no hospedado configura-se no dashboard (ver "Deploy" acima) | `supabase/config.toml` |
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
`lint → typecheck → test → build` foi verificada localmente dentro do contêiner
(Linux, igual ao runner). Os jobs `db` e `e2e` são novos e só foram validados
sintaticamente. **Observe a primeira execução real** — em especial se o
`supabase/setup-cli` e o `@supabase/cli-linux-x64` instalam limpo no `ubuntu-latest`.

Desde a `deploy-readiness` a base é **Node 22** em todos os lugares: os três
estágios do `Dockerfile`, `engines.node` e os jobs `build`/`e2e` da CI. O Node 20
saiu do LTS em abril/2026 (sem patches de segurança) e seis pacotes `@supabase/*`
declaram `node >= 22`, o que produzia `EBADENGINE` a cada `npm ci`.
