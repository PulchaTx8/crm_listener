# Supabase hospedado — aplicação e verificação das migrations

Registro do primeiro deploy do schema do Bloco 0 num projeto Supabase hospedado.
Data: 2026-07-26.

## Projeto

| | |
|---|---|
| Ref | `djbkdyesubkedxjwcohq` |
| Nome | CRMPulchatX |
| Região | `sa-east-1` (São Paulo) |
| Postgres | 17.6.1 — bate com `major_version = 17` do `config.toml` |

> **Atenção — dois projetos de nome quase idêntico.** `CRMPulchatX_Old`
> (`aewffpmguhqweznfrruu`) hospeda **outra aplicação em produção**: um CRM de
> WhatsApp com agentes de IA, 29 tabelas e dado vivo. **Sempre confira o ref, nunca
> o nome.** O ref deste projeto termina em `...wcohq`; o do outro, em `...nfrruu`.

## Incidente evitado

O primeiro `db push` foi feito com `--dry-run` e recusou-se a aplicar: encontrou 52
migrations remotas ausentes do repositório. O CLI sugeriu duas saídas, **ambas
destrutivas neste contexto**, e nenhuma foi executada:

- `supabase migration repair --status reverted <52 versões>` — marcaria as migrations
  da outra aplicação como revertidas, corrompendo o histórico dela.
- `supabase db pull` — despejaria o schema alheio dentro deste repositório.

A correção certa foi desvincular e criar um projeto dedicado. **Sempre rodar
`--dry-run` antes de um push para um banco que você não criou nesta sessão.**

## Aplicação

```
supabase link --project-ref djbkdyesubkedxjwcohq
supabase db push --dry-run     # confirmou apenas 0001 e 0002 pendentes
supabase db push
```

`0001` emitiu `NOTICE: extension "pgcrypto" already exists, skipping` — confirmando
na prática a premissa da correção feita antes do deploy: o `pgcrypto` já vem
instalado no schema `extensions`, e a versão original da migration era um no-op.

`supabase migration list --linked` confirmou `0001` e `0002` locais e remotas.

## Verificação de segurança — testada pela REST, não por inspeção de catálogo

As asserções foram feitas de fora, contra a API pública, com as chaves reais — isto é,
contra a superfície que um atacante teria.

| Teste | Resultado |
|---|---|
| `anon` SELECT em `rate_limit_counters` | HTTP 401 · `42501 permission denied` |
| `anon` DELETE em `rate_limit_counters` | HTTP 401 · `42501 permission denied` |
| `anon` RPC `rate_limit_hit` | HTTP 401 · `42501 permission denied` |
| `service_role` RPC `rate_limit_hit` | HTTP 200 · `allowed: true` |

A segunda linha é a que importa: era exatamente esse o defeito **crítico** encontrado
na revisão — com a RLS desligada, qualquer portador da chave pública apagava os
contadores e anulava o rate limiter. Está fechado no ambiente hospedado.

A terceira linha confirma que a função falha fechada: `rate_limit_hit` é
`SECURITY INVOKER` e continua com `EXECUTE` para `PUBLIC`, mas um chamador `anon`
esbarra na ausência de DML na tabela e nunca alcança dado.

### Semânticas do rate limiter

Sequência executada no banco hospedado, chave nova, janela de 60s:

| Chamada | `limit` | Resultado |
|---|---|---|
| 1 | 2 | `allowed=true, remaining=1` |
| 2 | 2 | `allowed=true, remaining=0` |
| 3 | 2 | `allowed=false, remaining=0` |
| 4 | 2 | `allowed=false, remaining=0` |
| 5 | **5** | `allowed=true, remaining=1` |

Idêntico, valor por valor, ao que `tests/unit/rate-limit.test.ts` afirma para a
implementação em memória — incluindo a chamada 5, o caso de limite variável que
revelou a divergência original entre as duas implementações. O contador saturou em
`limit+1 = 3`; com `limit=5`, `3 <= 5`, então incrementa para 4 e devolve
`remaining = 5-4 = 1`.

As linhas de sonda foram removidas ao final; a tabela ficou vazia.

### RLS

Os testes acima provam o **efeito** (o `anon` está bloqueado), mas não distinguem
"RLS ligada + grants revogados" de "RLS desligada + grants revogados", porque o
PostgREST não expõe o `pg_catalog`.

Confirmação por outro caminho: `supabase db diff --linked --schema public` retornou
**`No schema changes found`**. O schema remoto é idêntico ao local, e o local tem
`enable row level security` — verificado pelo pgTAP (7 asserções).

## O que NÃO foi executado, e por quê

- **`supabase config push`** — o `config.toml` é arquivo de desenvolvimento local.
  Empurrá-lo definiria no projeto hospedado `site_url = http://127.0.0.1:3000`,
  `enable_confirmations = false`, `minimum_password_length = 6` e limite de 2
  e-mails por hora. Site URL e Redirect URLs se configuram pelo painel.
- **`supabase db reset --linked`** — destrutivo.
- **pgTAP no remoto** — a extensão não é provisionada em projeto hospedado como é
  localmente. As mesmas propriedades foram asseguradas pelos testes REST acima, que
  são inclusive mais próximos do risco real.
