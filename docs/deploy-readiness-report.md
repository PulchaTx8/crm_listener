# Deploy readiness — registro de execução

Branch `deploy-readiness`, base `main@07c2376`.
Alvo: **Hostinger VPS + EasyPanel** (PaaS self-hosted sobre Docker + Traefik), com
**Supabase hospedado** (projeto ainda não criado).

Tudo abaixo foi verificado por execução real. A saída está reproduzida verbatim.

---

## 1. BLOCKER — o servidor bindava no ID do contêiner, não em `0.0.0.0`

**Diagnóstico.** O entrypoint standalone do Next é gerado com
`const hostname = process.env.HOSTNAME || '0.0.0.0'`, e o Docker **sempre** injeta
`HOSTNAME` com o ID do contêiner. O `||` nunca dispara: o processo escuta apenas no
IP para o qual aquele hostname resolve. Nunca `0.0.0.0`, nunca `127.0.0.1`.

Atrás do EasyPanel o contêiner entra em **duas** redes (a do serviço e a do proxy
Traefik). O bind pega uma delas; o proxy pode acertar a outra → 502. E um health
check em `localhost` nunca funcionaria.

**Correção.** `ENV HOSTNAME=0.0.0.0` no estágio **runner** do `Dockerfile` — o `ENV`
da imagem tem precedência sobre o valor injetado pelo daemon.

A prova completa está na seção [Prova em duas redes](#prova-em-duas-redes).

## 2. BLOCKER — `NEXT_PUBLIC_*` são fixados no build e o Dockerfile não os recebia

**Diagnóstico.** São inlined no bundle do cliente durante o `next build`. O estágio
builder não declarava nenhum `ARG`, então definir essas variáveis na aba
Environment (runtime) do EasyPanel **não alcança um bundle já compilado**. Hoje nada
quebra porque não há `'use client'` no repo, mas quebra no instante em que o Bloco 1
adicionar auth.

**Correção.** No estágio **builder**:

```dockerfile
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` **não** foi declarado como `ARG` — build args ficam
gravados nas camadas da imagem.

**Verificação — o ARG chega ao ambiente do `next build`:**

```
$ docker build --target builder \
    --build-arg NEXT_PUBLIC_SUPABASE_URL=https://build-arg-proof.supabase.co \
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-build-arg-proof -t crm-listener:builderproof .
$ docker run --rm crm-listener:builderproof sh -c 'env | grep -E "NEXT_PUBLIC_|SKIP_ENV" | sort'
NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-build-arg-proof
NEXT_PUBLIC_SUPABASE_URL=https://build-arg-proof.supabase.co
SKIP_ENV_VALIDATION=1

# mesmo estágio, sem passar build args — o que acontece se esquecerem no EasyPanel:
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SKIP_ENV_VALIDATION=1
```

**Verificação definitiva — o inlining no bundle do cliente.** Como o repo não tem
nenhum `'use client'`, foi criado um componente cliente **descartável**
(`src/app/argproof/page.tsx`, removido em seguida) que lê
`process.env.NEXT_PUBLIC_SUPABASE_URL`, exatamente o que o Bloco 1 vai fazer:

```
=== A) build COM build args ===
arquivos do bundle CLIENTE com o valor:
.next/static/chunks/app/argproof/page-40e19b3cbe4f142a.js
ocorrencias em .next/static = 1

=== B) build SEM build args (env só em runtime, como a aba Environment do EasyPanel) ===
ocorrencias em .next/static = 0
(env de runtime esta setada: https://build-arg-proof.supabase.co)
```

O caso **B** é o bug em estado puro: a variável de runtime está setada, o servidor a
enxerga, e o bundle que vai para o browser continua sem valor nenhum. Sem os `ARG`,
o auth do Bloco 1 subiria com o client Supabase sem URL.

Confirmado também que o segredo não vaza para a imagem:

```
$ docker history --no-trunc crm-listener:argproof | grep -c "SUPABASE_SERVICE_ROLE_KEY"
0
```

## 3. BLOCKER — não havia health check

**Correção.** Criado `src/app/api/health/route.ts`:

- Route Handler que devolve 200 com `{"status":"ok","uptime":<segundos>}`;
- `export const dynamic = 'force-dynamic'` — sem isso o Next otimizaria a rota
  estaticamente e o check mediria um arquivo, não o processo;
- **não toca no banco**, de propósito: health check que consulta o Supabase
  transforma oscilação de banco em restart de contêiner.

E no estágio runner:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
```

`wget` confirmado na imagem base (BusyBox), então `node -e` não foi necessário:

```
$ docker run --rm node:22-alpine sh -c 'which wget; wget --help 2>&1 | head -3; node -v'
/usr/bin/wget
BusyBox v1.37.0 (2026-01-10 15:38:28 UTC) multi-call binary.

Usage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]
v22.23.1
```

A saída do `docker build` confirma que a rota ficou dinâmica:

```
Route (app)                                 Size  First Load JS
┌ ○ /                                      127 B         103 kB
├ ○ /_not-found                            991 B         103 kB
└ ƒ /api/health                            127 B         103 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

## 4. Node 20 → 22

Node 20 saiu do LTS em abril/2026 (sem patches de segurança) e seis pacotes
`@supabase/*` declaram `node >= 22`, produzindo `EBADENGINE`.

| Arquivo | Mudança |
|---|---|
| `Dockerfile` | `node:20-alpine` → `node:22-alpine` nos **três** estágios (`deps`, `builder`, `runner`) |
| `package.json` | `engines.node`: `">=20"` → `">=22"` |
| `.github/workflows/ci.yml` | `node-version: 20` → `22` |

Sobre a CI: os três jobs foram conferidos um a um. Apenas **dois** definem
`node-version` — `build` (linha 15) e `e2e` (linha 47). O job `db` **não usa Node**:
roda pela `supabase/setup-cli@v1` e não faz `npm ci`, então não havia nada a mudar
ali. Confirmado por busca:

```
$ grep -n "node-version" .github/workflows/ci.yml
15:          node-version: 22
47:          node-version: 22
```

O build da imagem confirma a versão em uso: `v22.23.1`.

## 5. `0001_extensions.sql` era no-op e `digest()` não resolvia

**Verificado no banco real, antes da edição:**

```
$ docker exec supabase_db_CRM_-_LISTENER psql -U postgres -At \
    -c "select e.extname, n.nspname from pg_extension e
        join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';" \
    -c "set search_path = pg_catalog, public;
        select coalesce(to_regprocedure('digest(bytea,text)')::text, 'NULL') as unqualified,
               coalesce(to_regprocedure('extensions.digest(text,text)')::text,'NULL') as qualified;"
pgcrypto|extensions
SET
NULL|extensions.digest(text,text)
```

Os dois fatos do review confirmados: a `pgcrypto` já está no schema **`extensions`**
(então `create extension if not exists pgcrypto;` não fazia nada), e `digest()`
**não é resolvível** de dentro de uma função que fixa `search_path = pg_catalog,
public` — só a forma totalmente qualificada resolve. O `rate_limit_hit` fixa
exatamente essa search_path, e a função de hash de documento do Bloco 1 seguiria o
mesmo padrão.

**Correção** (editada in place — o projeto hospedado não existe, a migração nunca
rodou fora do local; nenhuma `0003` foi criada):

```sql
create extension if not exists pgcrypto with schema extensions;
```

Além disso: o comentário antigo atribuía `gen_random_uuid()` à pgcrypto — errado no
PG13+, onde a função é builtin do `pg_catalog`. Comentário corrigido, e registrado no
arquivo que `digest()` precisa ser chamada como `extensions.digest(...)` dentro de
funções com search_path fixada.

Após o `db:reset`, o estado se mantém:

```
pgcrypto -> extensions
SET
unqualified=NULL | qualified=extensions.digest(text,text)
```

## 6. Documentação

**`docs/bloco-0-handoff.md`** ganhou a seção "Deploy — EasyPanel (Hostinger VPS) e
Supabase hospedado", com:

- **Bind em `0.0.0.0`** — por que o `docker run -p 3000:3000` numa rede só não revela
  o bug, e por que atrás do Traefik ele vira 502.
- **Health check** — por que a rota não pode tocar no banco.
- **Tabela build-time × runtime** — `NEXT_PUBLIC_*` vão em **Build args _e_
  Environment**; `SUPABASE_SERVICE_ROLE_KEY` vai **só em Environment**.
- **Aviso destacado sobre `SKIP_ENV_VALIDATION`** (ver abaixo).
- **`supabase config push` — não rode.** `config.toml` é arquivo de dev local.
  Empurrá-lo sobrescreveria a produção com `site_url = "http://127.0.0.1:3000"`,
  `additional_redirect_urls = ["https://127.0.0.1:3000"]`,
  `[auth.email] enable_confirmations = false`, `minimum_password_length = 6` e
  `[auth.rate_limit] email_sent = 2` (2 e-mails/hora no projeto inteiro). Valores
  conferidos no arquivo. Procedimento correto documentado:
  `supabase link --project-ref <ref>` seguido de `supabase db push`, com Site URL e
  Redirect URLs configurados **no dashboard**. Registrado também que
  `major_version = 17` precisa bater com o projeto hospedado e que
  **`supabase db reset --linked` é destrutivo e não deve ser usado**.
- **Convenção de GRANT.** O mesmo defeito de permissão pegou `rate_limit_counters`
  duas vezes numa sessão (primeiro RLS desligada, depois `service_role` sem DML). A
  causa raiz é um default da plataforma: tabela nova não recebe GRANT de DML, e
  `BYPASSRLS` não substitui GRANT ausente quando a função é `SECURITY INVOKER`. Regra
  registrada: **toda tabela nova acessada via `createServiceClient()` precisa de
  `grant ... to service_role` explícito na migração**; RPCs `SECURITY DEFINER`
  escapam porque rodam como o dono.
- **`digest()` mora em `extensions`** — resumo do item 5 para o Bloco 1.

**Tabela de dívida atualizada:**

| Linha | O que foi feito |
|---|---|
| `register()` cobre só `nodejs`; sem `HEALTHCHECK` no Dockerfile | **Amendada** — a parte do `HEALTHCHECK` foi resolvida; sobrou só a cobertura do runtime `nodejs` no `instrumentation.ts` |
| `EBADENGINE`: seis `@supabase/*` querem Node ≥ 22 | **Marcada resolvida** |
| GitHub deprecou Node 20 nas actions | **Marcada resolvida** |
| `config.toml`: `site_url` http vs `additional_redirect_urls` https | Amendada com ponteiro para a nova seção de deploy |

A seção "Estado da CI" também foi atualizada: não afirma mais que a verificação
local foi feita em `node:20-alpine`.

**`.env.example`** reorganizado em três blocos explícitos — BUILD-TIME,
RUNTIME-ONLY e "NUNCA definir em runtime" —, este último cobrindo
`SKIP_ENV_VALIDATION`.

### Aviso operacional — `SKIP_ENV_VALIDATION`

> **Nunca defina `SKIP_ENV_VALIDATION` no Environment do EasyPanel.**

Ela existe apenas dentro do estágio builder do `Dockerfile` (escopo já correto),
porque durante o `next build` os segredos legitimamente não existem. Se vazar para o
runtime, `src/lib/env.ts` cai no ramo frouxo (`parseLooseEnv`), a validação de boot
**desaparece em silêncio** e o contêiner sobe sem nenhuma configuração de Supabase —
falhando na primeira query, em produção, em vez de falhar no boot. Registrado em
destaque tanto no `.env.example` quanto no handoff.

---

## Verificação

A imagem `crm-listener:dev` local estava **stale** (construída antes da correção do
`process.exit(1)`). Foi reconstruída do zero antes de qualquer conclusão.

### `npm run lint`

```
> crm-listener@0.1.0 lint
> next lint --dir src --dir tests

`next lint` is deprecated and will be removed in Next.js 16.
For new projects, use create-next-app to choose your preferred linter.
For existing projects, migrate to the ESLint CLI:
npx @next/codemod@canary next-lint-to-eslint-cli .

✔ No ESLint warnings or errors
```

(O aviso de deprecação do `next lint` é dívida pré-existente já registrada no handoff.)

### `npm run typecheck`

```
> crm-listener@0.1.0 typecheck
> tsc --noEmit
```

Sem saída — sem erros.

### `npm run test`

```
 RUN  v2.1.9 M:/CRM - LISTENER

 ✓ tests/unit/supabase-config.test.ts (2 tests) 19ms
 ✓ tests/unit/rate-limit.test.ts (4 tests) 2ms
 ✓ tests/unit/errors.test.ts (3 tests) 2ms
 ✓ tests/unit/sanity.test.ts (1 test) 4ms
 ✓ tests/unit/mailer.test.ts (1 test) 2ms
 ✓ tests/unit/env.test.ts (6 tests) 33ms
 ✓ tests/unit/logger.test.ts (5 tests) 6ms

 Test Files  7 passed (7)
      Tests  22 passed (22)
   Duration  655ms
```

**22 testes**, como esperado. Nenhum teste novo foi adicionado.

### `npm run test:e2e`

```
Running 1 test using 1 worker

  ok 1 tests\e2e\home.spec.ts:3:5 › home mostra o título da fundação (371ms)

  1 passed (4.0s)
```

### `npm run db:reset`

```
> crm-listener@0.1.0 db:reset
> supabase db reset

Resetting local database...
Recreating database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 0001_extensions.sql...
NOTICE (42710): extension "pgcrypto" already exists, skipping
Applying migration 0002_rate_limit.sql...
WARN: no files matched pattern: supabase/seed.sql
Restarting containers...
Finished supabase db reset on branch deploy-readiness.
```

O `NOTICE ... already exists, skipping` é a confirmação direta do diagnóstico do
item 5: mesmo com `with schema extensions`, a instrução continua sendo no-op **porque
a extensão já está lá, no schema certo**. A migração agora documenta esse fato em vez
de fingir que instala algo.

### `npm run db:test`

```
> crm-listener@0.1.0 db:test
> supabase test db

Connecting to local database...
/CRM - LISTENER/supabase/tests/00_smoke.test.sql .. ok
All tests successful.
Files=1, Tests=7,  0 wallclock secs ( 0.01 usr +  0.01 sys =  0.02 CPU)
Result: PASS
```

**7 asserts pgTAP**, como esperado — a `0001` editada aplica limpo.

### `docker build -t crm-listener:dev .`

Build completo, sem erros. Trechos relevantes:

```
#5 [internal] load metadata for docker.io/library/node:22-alpine
#13 [deps 4/4] RUN npm ci
#13 19.96 added 458 packages, and audited 459 packages in 20s
#13 DONE 20.3s
...
#16 [builder 5/5] RUN npm run build
#16 0.915    ▲ Next.js 15.5.22
#16 6.431  ✓ Compiled successfully in 3.9s
#16 6.434    Linting and checking validity of types ...
#16 9.751  ✓ Generating static pages (4/4)
#16 24.68 Route (app)                                 Size  First Load JS
#16 24.68 ┌ ○ /                                      127 B         103 kB
#16 24.68 ├ ○ /_not-found                            991 B         103 kB
#16 24.68 └ ƒ /api/health                            127 B         103 kB
#16 DONE 24.9s
...
#20 naming to docker.io/library/crm-listener:dev done
#20 DONE 1.7s
```

Nenhum `EBADENGINE` no `npm ci` — o item 4 fecha. (Os `npm warn deprecated` que
restam são de dependências transitivas do ESLint 8, dívida pré-existente.)

### Caso negativo — o guard de boot

Contêiner **sem** variáveis de ambiente precisa sair com código não-zero:

```
$ docker run --rm --name crm-noenv crm-listener:dev; echo "EXIT_CODE=$?"
   ▲ Next.js 15.5.22
   - Local:        http://localhost:3000
   - Network:      http://0.0.0.0:3000

 ✓ Starting...
Error: Configuração de ambiente inválida — NEXT_PUBLIC_SUPABASE_URL: Required; NEXT_PUBLIC_SUPABASE_ANON_KEY: Required; SUPABASE_SERVICE_ROLE_KEY: Required
    at aE (.next/server/chunks/278.js:1:57015)
    at 7278 (.next/server/chunks/278.js:1:57183)
    at Function.c (.next/server/webpack-runtime.js:1:127)
    at async Module.d (.next/server/instrumentation.js:1:99)
EXIT_CODE=1
```

O guard continua valendo. E note o banner: `Network: http://0.0.0.0:3000` — antes da
correção do item 1 ele imprimia o ID do contêiner.

---

## Prova em duas redes

Um `docker run -p 3000:3000` numa rede só **não consegue revelar** o bug do item 1: o
IP do contêiner é justamente o publicado, então o teste passa das duas formas. A
topologia real do EasyPanel foi reproduzida.

### Montagem

Duas redes descartáveis, e o contêiner anexado às duas **antes** de o processo
bindar (`docker create` → `network connect` → `docker start`, para garantir que as
duas interfaces já existem no momento do bind):

```
$ docker network create crm-svc-net
$ docker network create crm-proxy-net
crm-proxy-net	bridge	local
crm-svc-net	bridge	local

$ docker create --name crm-app --network crm-svc-net --network-alias crm-app \
    -e NEXT_PUBLIC_SUPABASE_URL=https://dummy.supabase.co \
    -e NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy-anon-key \
    -e SUPABASE_SERVICE_ROLE_KEY=dummy-service-role-key \
    crm-listener:dev
$ docker network connect --alias crm-app crm-proxy-net crm-app
$ docker start crm-app
```

Duas redes, dois IPs:

```
--- redes anexadas ---
crm-proxy-net=172.20.0.2
crm-svc-net=172.19.0.2

--- HOSTNAME dentro do contêiner ---
HOSTNAME=0.0.0.0
ec99b9dc239d
--- /etc/hosts ---
127.0.0.1	localhost
::1	localhost ip6-localhost ip6-loopback
fe00::	ip6-localnet
ff00::	ip6-mcastprefix
ff02::1	ip6-allnodes
ff02::2	ip6-allrouters
172.20.0.2	ec99b9dc239d
172.19.0.2	ec99b9dc239d
```

Aqui está o mecanismo inteiro à vista: o `/etc/hostname` continua sendo o ID do
contêiner (`ec99b9dc239d`) e o `/etc/hosts` o mapeia para **dois** IPs — o resolvedor
devolve só o primeiro. Mas `HOSTNAME=0.0.0.0`, porque o `ENV` da imagem venceu o
valor injetado pelo daemon. É exatamente essa precedência que a correção explora.

### Resultado com a correção

```
=== 1) Caminho do Traefik: 2º contêiner na crm-proxy-net -> crm-app por nome ===
  HTTP/1.1 200 OK
  vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
  content-type: application/json
  Date: Sun, 26 Jul 2026 18:58:49 GMT
  Connection: close
  Transfer-Encoding: chunked

{"status":"ok","uptime":13}

=== 2) Mesmo teste pela crm-svc-net ===
  HTTP/1.1 200 OK
  vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
  content-type: application/json
  Date: Sun, 26 Jul 2026 18:58:49 GMT
  Connection: close
  Transfer-Encoding: chunked

{"status":"ok","uptime":14}

=== 3) localhost dentro do contêiner (exatamente o que o HEALTHCHECK roda) ===
{"status":"ok","uptime":14}
EXIT=0
```

Socket em escuta:

```
$ docker exec crm-app sh -c 'cat /proc/net/tcp | awk "NR>1 {print \$2}"'
00000000:0BB8      <- 0.0.0.0:3000
0B00007F:B487
0100007F:D6F0
0100007F:A64A
0100007F:BDDC
```

`00000000:0BB8` = `0.0.0.0:3000`. Bind em todas as interfaces.

E o `HEALTHCHECK` do Docker converge:

```
$ docker inspect --format '{{.Name}} -> {{.State.Health.Status}}' crm-app
/crm-app -> healthy
```

### Controle — o mesmo cenário com o comportamento pré-correção

Para mostrar que a correção é *load-bearing* e não decorativa, um segundo contêiner
subiu na mesma topologia com o `HOSTNAME` de volta ao que o Docker faz por padrão
(hostname do contêiner injetado na variável):

```
$ docker create --name crm-app-bug --hostname crmbug \
    --network crm-svc-net --network-alias crm-app-bug -e HOSTNAME=crmbug \
    -e NEXT_PUBLIC_SUPABASE_URL=... -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
    -e SUPABASE_SERVICE_ROLE_KEY=... crm-listener:dev
$ docker network connect --alias crm-app-bug crm-proxy-net crm-app-bug
$ docker start crm-app-bug
```

```
--- IPs ---
crm-proxy-net=172.20.0.3
crm-svc-net=172.19.0.3

--- /etc/hosts do controle ---
172.20.0.3	crmbug
172.19.0.3	crmbug

--- para qual IP crmbug resolve de dentro ---
172.20.0.3        crmbug  crmbug

--- banner do Next ---
   ▲ Next.js 15.5.22
   - Local:        http://crmbug:3000
   - Network:      http://crmbug:3000

 ✓ Starting...
 ✓ Ready in 76ms

--- socket em escuta (controle) ---
030014AC:0BB8      <- 172.20.0.3:3000  (UM único IP)
0B00007F:8A1D
```

O contraste é literal: `00000000:0BB8` (corrigido, todas as interfaces) contra
`030014AC:0BB8` (controle, **só** `172.20.0.3`). O hostname resolvia para dois IPs e
o Node bindou apenas no primeiro.

Consequências, medidas:

```
=== alcance a partir da crm-proxy-net (caminho do Traefik) ===
{"status":"ok","uptime":17}
EXIT=0
=== alcance a partir da crm-svc-net ===
wget: can't connect to remote host (172.19.0.3): Connection refused
EXIT=1

--- localhost (o que o HEALTHCHECK roda) ---
wget: can't connect to remote host (127.0.0.1): Connection refused
EXIT=1
```

Uma rede responde, a outra dá **Connection refused** — e qual das duas ganha é
acidente da ordem de resolução, não algo que se possa configurar. Esse é
exatamente o 502 intermitente atrás do Traefik. O `localhost` também recusa, então o
`HEALTHCHECK` nunca passaria:

```
$ docker inspect --format '{{.State.Health.Status}}' crm-app-bug
t+10s crm-app-bug=starting
t+20s crm-app-bug=starting
t+30s crm-app-bug=starting
t+40s crm-app-bug=starting
t+50s crm-app-bug=unhealthy

--- log do health check do controle ---
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
```

**Placar: corrigido `healthy` + 200 nas duas redes; controle `unhealthy` + Connection
refused em uma das redes e no localhost.** Mesma imagem, mesma topologia, única
variável diferente: `HOSTNAME`.

### Limpeza

```
$ docker rm -f crm-app crm-app-bug
crm-app
crm-app-bug
$ docker network rm crm-svc-net crm-proxy-net
crm-svc-net
crm-proxy-net
$ docker network ls --filter name=crm- --format '{{.Name}}'
(vazio)
$ docker ps -a --filter name=crm-app --format '{{.Names}}'
(vazio)
$ docker images crm-listener --format '{{.Repository}}:{{.Tag}}'
crm-listener:dev
```

As tags descartáveis (`argproof`, `argproof-a`, `argproof-b`, `builderproof`,
`builderproof2`) foram removidas **uma a uma por nome** — nenhum `docker prune` foi
executado. O stack do Supabase não foi tocado além do `db:reset`/`db:test`
esperados; `supabase stop`/`start` não foram usados.

---

## Ressalvas

1. **Item 2 não pôde ser provado no código de produção**, porque o repo ainda não tem
   nenhum `'use client'` e nenhuma página importa `src/lib/supabase/config.ts` — a
   busca pelo marcador no bundle de produção devolve 0 ocorrências simplesmente
   porque o módulo nunca entra em bundle nenhum. A prova exigiu um componente cliente
   descartável, criado e removido durante a verificação. A correção está certa e o
   mecanismo foi demonstrado, mas quem adicionar o auth no Bloco 1 deve **confirmar
   na prática** que os `NEXT_PUBLIC_*` aparecem no bundle servido.
2. **A CI continua nunca tendo rodado no GitHub.** A mudança para Node 22 foi
   validada localmente dentro do contêiner (`node:22-alpine`, `npm ci` limpo, sem
   `EBADENGINE`), mas a primeira execução real do workflow segue por observar.
3. **`supabase_vector` está em `Restarting`** no stack local — estado **anterior** a
   esta tarefa, não causado por ela, e sem efeito sobre `db:reset`/`db:test`, que
   passaram. Vale olhar em algum momento.
4. **O `HEALTHCHECK` cobre liveness, não readiness.** Se o Supabase hospedado cair, o
   contêiner segue `healthy` — decisão deliberada (ver item 3), mas significa que o
   monitoramento de dependências externas precisa vir de outro lugar.
5. **Nada disso foi exercitado contra o Supabase hospedado**, que ainda não existe. O
   procedimento de `link`/`db push` está documentado, mas não executado.
