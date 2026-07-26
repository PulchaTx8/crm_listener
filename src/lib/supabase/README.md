# Clients Supabase (decisão D4)

- `createUserClient()` — client por-requisição com o JWT do usuário (via cookies). **Padrão** para
  toda leitura/escrita de dados de tenant. A RLS do banco é aplicada.
- `createServiceClient()` — client `service_role`, marcado `server-only`. **RLS é ignorada.** Usar
  APENAS em webhook do WhatsApp, jobs de cron, ETL de migração e operações de plataforma.
  Funções `SECURITY DEFINER` chamadas com qualquer client re-checam permissão internamente (H2).

Nunca importar `service-client.ts` em componentes de cliente. Nunca expor `SUPABASE_SERVICE_ROLE_KEY`.
