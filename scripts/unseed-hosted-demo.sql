-- Takes a demonstration Organization back out of a project, with everything
-- under it. The companion to scripts/seed-hosted-demo.mjs.
--
-- SQL AND NOT A SCRIPT, and that is not a preference. service_role -- the only
-- credential a Node script has against a hosted project -- holds DELETE on six
-- tables in this schema: contact_requests, platform_admins, profiles,
-- rate_limit_counters, report_runs, whatsapp_conversations. On the other forty
-- it can SELECT and nothing more. A teardown written against PostgREST gets
-- 42501 from every table that matters, and if it treats that as "nothing to do"
-- it reports a clean database over a full one. This ran that way once; the
-- verification pass is what caught it.
--
-- HOW TO RUN IT
--   Supabase dashboard -> SQL Editor -> paste -> Run. It executes as `postgres`,
--   which has the grants service_role does not.
--   Or: psql "$DATABASE_URL" -f scripts/unseed-hosted-demo.sql
--
-- The Organization name is on ONE line, below. Nothing else needs editing.
--
-- WHY THE ORDER IS THE WHOLE FILE
--   Every foreign key in this schema is NO ACTION -- verified against
--   pg_constraint, not assumed. Nothing cascades. So children must go first, and
--   the last statement succeeding is itself the proof that nothing was missed:
--   a single surviving row anywhere would make `delete from organizations` fail
--   with 23503 rather than let this finish quietly.

do $$
declare
  -- ---------------------------------------------------------------------
  v_name   text   := 'PULCHATX DEMO';
  v_emails text[] := array['demo@pulchatx.com', 'demo-provisioner@pulchatx.com'];
  -- ---------------------------------------------------------------------

  v_org       uuid;
  v_companies uuid[];
  v_step      text;
  v_table     text;
  v_scope     text;
  v_n         bigint;
  v_total     bigint := 0;
  v_pending   text[];
  v_next      text[];
  v_progress  boolean;

  /*
   * table:scope, children before parents.
   *
   *   org          delete by organization_id
   *   company      delete by company_id, for this Organization's Stations
   *   integration  delete by integration_id, for this Organization's integrations
   *
   * invitation_companies and api_credential_scopes are absent because they are
   * the only two things in this schema that DO cascade, from invitations (0018)
   * and api_credentials (0148) respectively.
   */
  v_steps text[] := array[
    -- the draw and what it produced
    'winner_status_history:company',
    'winners:company',
    'draw_entries:company',
    'draws:org',
    -- entries
    'participation_answers:org',
    'member_consents:org',
    'promotion_refusals:org',
    'participations:org',
    -- promotions and the stock committed to them. inventory_movements leads:
    -- the ledger row that records "these units went to this promotion" points at
    -- promotion_prizes, so the ledger has to go before the link does.
    'promotion_question_options:org',
    'promotion_questions:org',
    'inventory_movements:org',
    'inventory_balances:org',
    'promotion_prize_balances:org',
    'promotion_prizes:org',
    'promotions:org',
    'prizes:org',
    'prize_categories:org',
    -- music: requests, then songs, then what songs point at
    'music_requests:org',
    'music_merges:org',
    'songs:org',
    'albums:org',
    'artists:org',
    'record_labels:org',
    'music_genres:org',
    'shows:org',
    -- the audience
    'member_notes:org',
    'member_blocks:org',
    'member_field_confirmations:org',
    'member_company_links:org',
    'members:org',
    -- messaging, and the conversations that hang off an integration rather than
    -- off an Organization
    'station_message_templates:org',
    'message_templates:org',
    'whatsapp_conversation_leases:integration',
    'whatsapp_conversations:integration',
    'outbox_messages:org',
    'webhook_events:org',
    'integrations:org',
    -- doors
    'widget_verifications:org',
    'widget_installations:org',
    'api_credentials:org',
    'invitations:org',
    -- people and the record of what they did
    'company_memberships:org',
    'organization_memberships:org',
    'report_runs:org',
    'audit_logs:org',
    -- the Stations themselves, then the roles they were using
    'companies:org',
    'roles:org'
  ];
begin
  select id into v_org from public.organizations where name = v_name;

  if v_org is null then
    raise notice 'No Organization named "%". Nothing to do.', v_name;
    return;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
    into v_companies
    from public.companies
   where organization_id = v_org;

  raise notice 'Organization % (%), % station(s)', v_name, v_org, coalesce(array_length(v_companies, 1), 0);

  /*
   * BUSINESS TRIGGERS OFF, FOREIGN KEYS ON.
   *
   * organization_memberships_keep_owner is a constraint trigger that refuses to
   * let an Organization reach zero owners -- and it never asks whether the
   * Organization is still there, so removing one entirely always trips it. It is
   * DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT: the run below prints
   * every table it emptied, and then the whole transaction rolls back at the
   * end. A teardown that reports 411 rows removed and removes none is worse than
   * one that fails on line one.
   *
   * `disable trigger user` leaves internally generated triggers alone, which is
   * every foreign key in the schema. So the constraint this file leans on for
   * its proof stays armed, and only the rules that assume a live Organization go
   * quiet.
   *
   * Safe against a crash halfway: DDL is transactional in Postgres. Either the
   * whole thing commits with the triggers back on, or it rolls back and they
   * were never off.
   */
  foreach v_step in array v_steps loop
    execute format('alter table public.%I disable trigger user', split_part(v_step, ':', 1));
  end loop;
  execute 'alter table public.organizations disable trigger user';
  execute 'alter table public.profiles disable trigger user';

  /*
   * The order above is a hypothesis, and hand-ordering forty-six tables is how
   * you ship a teardown that stops half-way on somebody else's database. So a
   * table that still has a child defers to the next pass instead of aborting the
   * run, and the loop repeats until a pass clears everything.
   *
   * A pass that deletes from nothing at all is the real failure, and it raises
   * with the tables still standing -- which names the missing edge precisely,
   * rather than leaving a half-emptied Organization behind.
   */
  v_pending := v_steps;

  loop
    v_next := '{}';
    v_progress := false;

    foreach v_step in array v_pending loop
      v_table := split_part(v_step, ':', 1);
      v_scope := split_part(v_step, ':', 2);

      begin
        if v_scope = 'org' then
          execute format('delete from public.%I where organization_id = $1', v_table) using v_org;
        elsif v_scope = 'company' then
          execute format('delete from public.%I where company_id = any($1)', v_table) using v_companies;
        elsif v_scope = 'integration' then
          execute format(
            'delete from public.%I where integration_id in '
            '(select id from public.integrations where organization_id = $1)', v_table) using v_org;
        else
          raise exception 'unknown scope "%" for table %', v_scope, v_table;
        end if;

        get diagnostics v_n = row_count;
        v_total := v_total + v_n;
        v_progress := true;
        if v_n > 0 then
          raise notice '  %  %', rpad(v_table, 30), v_n;
        end if;
      exception
        when foreign_key_violation then
          v_next := v_next || v_step;
      end;
    end loop;

    exit when array_length(v_next, 1) is null;

    if not v_progress then
      raise exception 'deadlocked on: %', array_to_string(v_next, ', ');
    end if;

    v_pending := v_next;
  end loop;

  delete from public.organizations where id = v_org;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- The accounts. platform_admins first: a seed run that died before its own
  -- last step leaves the temporary provisioner still privileged, and that row
  -- would block nothing -- it has to be named or it stays.
  delete from public.platform_admins
   where user_id in (select id from auth.users where email = any(v_emails));
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;
  if v_n > 0 then
    raise notice '  platform_admins                 %', v_n;
  end if;

  delete from public.profiles where email = any(v_emails);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  delete from auth.users where email = any(v_emails);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;
  if v_n > 0 then
    raise notice '  auth.users                      %', v_n;
  end if;

  foreach v_step in array v_steps loop
    execute format('alter table public.%I enable trigger user', split_part(v_step, ':', 1));
  end loop;
  execute 'alter table public.organizations enable trigger user';
  execute 'alter table public.profiles enable trigger user';

  -- Belt and braces. The foreign keys already made this unreachable -- the
  -- delete above would have raised 23503 -- but a teardown that ends by ASKING
  -- rather than by assuming is the one worth trusting the second time.
  if exists (select 1 from public.organizations where id = v_org) then
    raise exception 'the Organization is still there after the delete';
  end if;

  raise notice '% row(s) removed. Nothing of "%" is left.', v_total, v_name;
end $$;
