-- supabase/migrations/0129_list_audit_logs.sql

-- Block 10a, Task 1: the trail nobody could read.
--
-- audit_logs has been collecting rows since Block 1b -- nine blocks of member
-- edits, role changes, stock movements, deliveries, erasures, and since Block
-- 8b every report export -- and nothing in the product can display one. The
-- audit.view permission has granted access to a screen that does not exist for
-- just as long. Block 8b sharpened that from untidy into a real gap: it shipped
-- no reports.export permission on the argument that THE TRAIL IS THE CONTROL,
-- which is only true if somebody can read the trail.
--
-- ============================================================================
-- SECURITY INVOKER, AND THIS IS THE DECISION THE WHOLE BLOCK RESTS ON.
-- ============================================================================
--
-- Every other list RPC in this codebase is SECURITY DEFINER, and each one has a
-- reason: it needs to be NARROWER than RLS (an archived promotion's entries),
-- or it needs a column that RLS cannot express per-row (the listener's name
-- behind members.view). This one needs neither. audit_logs already carries
-- exactly the right rule, in two policies:
--
--   audit_logs_select_admin  ->  is_platform_admin()
--   audit_logs_select_org    ->  organization_id is not null
--                                and has_org_permission('audit.view', organization_id)
--
-- A SECURITY DEFINER listing would have to restate both by hand. This is the
-- one table in the schema where restating them WRONG is least likely to be
-- noticed: the screen would still render, still paginate, and still look like
-- an audit trail -- there is no user-visible difference between "the audit
-- viewer" and "the audit viewer, showing slightly too much". 0095's header
-- records a second permission term lost that way for five commits, and Block
-- 8a's D4 gives the general form: in a COUNT, including a row the caller could
-- not read looks like a number rather than like a leak. An audit viewer is a
-- count of what happened.
--
-- The `organization_id is not null` term in the second policy is not
-- decoration either, and it is the specific thing a rewrite loses: a row with a
-- null organization_id -- written by a platform-level operation that belongs to
-- no customer -- reaches the platform admin through the FIRST policy and nobody
-- else. tests/isolation/audit.test.ts asserts exactly that, because pgTAP
-- (superuser, null auth.uid()) cannot.
--
-- So: no permission check in this body at all. The policies are the check, and
-- adding one here would be a second implementation of a rule that already has a
-- home.
--
-- GRANTED TO authenticated ONLY. service_role has no use for it -- it bypasses
-- RLS, so this function would answer it with everything, which is precisely the
-- shape the paragraph above rejects. Granting it would put the DEFINER mistake
-- back in through a side door.

create function public.list_audit_logs(
  p_actor_id     uuid        default null,
  p_action       text        default null,
  p_target_table text        default null,
  p_company_id   uuid        default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null,
  p_succeeded    boolean     default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    bigint      default null,
  p_limit        integer     default 51
)
returns table (
  id              bigint,
  created_at      timestamptz,
  actor_id        uuid,
  actor_name      text,
  action          text,
  target_table    text,
  target_id       uuid,
  organization_id uuid,
  company_id      uuid,
  company_name    text,
  succeeded       boolean,
  detail          jsonb,
  total_count     bigint
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_term text := nullif(btrim(coalesce(p_action, '')), '');
begin
  return query
  with filtered as (
    -- No cursor predicate here, deliberately. total_count is computed over THIS
    -- CTE, so it answers "how many rows match the filters" rather than "how many
    -- are left after the cursor" -- which would shrink on every page and read as
    -- rows disappearing. 0090 set the rule that the count comes from the same
    -- source as the rows; this splits the cursor out so it can.
    select
      a.id, a.created_at, a.actor_id, a.action, a.target_table, a.target_id,
      a.organization_id, a.company_id, a.succeeded, a.detail,
      -- Plain full_name, nullable (0003), and NO coalesce onto an e-mail:
      -- 0096 wrote that coalesce once and removed it in review. A null here
      -- does NOT mean "the system did it" -- that is actor_id's job, and it
      -- ships beside this column for exactly that reason.
      p.full_name as actor_name,
      c.name      as company_name
    from public.audit_logs a
    left join public.profiles  p on p.id = a.actor_id
    left join public.companies c on c.id = a.company_id
    where (p_actor_id     is null or a.actor_id = p_actor_id)
      and (v_term         is null or a.action = v_term)
      and (p_target_table is null or a.target_table = p_target_table)
      and (p_company_id   is null or a.company_id = p_company_id)
      and (p_from         is null or a.created_at >= p_from)
      and (p_to           is null or a.created_at <  p_to)
      and (p_succeeded    is null or a.succeeded = p_succeeded)
  ),
  counted as (select count(*) as n from filtered)
  select
    f.id, f.created_at, f.actor_id, f.actor_name, f.action, f.target_table,
    f.target_id, f.organization_id, f.company_id, f.company_name,
    f.succeeded, f.detail, counted.n
  from filtered f, counted
  -- The tuple comparison, not two separate ones: comparing the columns
  -- independently strands rows on the far side of a shared timestamp, silently,
  -- because the pages still load and the total still looks right. `id` is a
  -- BIGINT here and not a uuid -- the one keyset in this codebase whose cursor
  -- is not -- so a caller passing a uuid gets a type error rather than a subtly
  -- wrong page.
  where p_cursor_at is null
     or (f.created_at, f.id) < (p_cursor_at, p_cursor_id)
  order by f.created_at desc, f.id desc
  limit p_limit;
end;
$$;

comment on function public.list_audit_logs(uuid, text, text, uuid, timestamptz, timestamptz, boolean, timestamptz, bigint, integer) is
  'One keyset page of the Organization''s audit trail, newest first. SECURITY INVOKER, ALONE among this codebase''s list RPCs: audit_logs already carries the right rule in two policies (platform admin sees everything; an Organization member sees its rows through has_org_permission(''audit.view'')), and this is the one table where restating that by hand and getting it wrong would be invisible -- the screen would still render and still look like an audit trail. The null-organization_id row, which belongs to no customer and reaches only the platform admin, is the specific term such a rewrite loses. actor_name is profiles.full_name and is nullable: a null there does NOT mean the system acted, which is what actor_id beside it answers.';

revoke execute on function public.list_audit_logs(uuid, text, text, uuid, timestamptz, timestamptz, boolean, timestamptz, bigint, integer) from public;
grant execute on function public.list_audit_logs(uuid, text, text, uuid, timestamptz, timestamptz, boolean, timestamptz, bigint, integer) to authenticated;
