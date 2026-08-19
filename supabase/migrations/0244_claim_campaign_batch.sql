-- supabase/migrations/0244_claim_campaign_batch.sql

-- Block 29d-2, Task 4. The claim the fifth drain (Task 6) takes a batch of
-- recipient rows with.
--
-- claim_outbox_batch is this function's template, read live via
-- pg_get_functiondef rather than trusted from any one migration's text: it
-- has been dropped and recreated more than once since it was first written
-- (verified with `grep -ln claim_outbox_batch supabase/migrations/*.sql` and
-- reading every hit, rather than enumerated here, because a list in a
-- comment goes stale the next time somebody recreates it -- precisely how
-- this sentence was wrong before this fix), so the version on disk in any
-- single migration file is not the version running.
-- The shape this function borrows: ONE STATEMENT, so choosing the batch and
-- marking it claimed cannot be pulled apart by an overlapping tick; `for
-- update skip locked` so a second call takes the next rows instead of
-- blocking on these; attempts returned UNCHANGED, because claiming is not
-- attempting; and a trailing ORDER BY, because UPDATE ... RETURNING has no
-- defined row order and "oldest due first" is a claim nothing else would
-- support.
--
-- THE PREDICATE IS CHECKED EXACTLY -- `status = 'pending'` alone, never also
-- `claimed` -- because message_campaign_recipients_sendable_idx (0242) is
-- partial on exactly that predicate, and outbox_messages' own migration
-- (0059), about the index claim_outbox_batch (0063) scans, explains why: a
-- predicate naming a status this function can ALSO see would stop being part
-- of the index condition and become a FILTER applied after the fetch, and
-- whether the planner still uses the index at all would then depend on how
-- large the table had grown -- a claim that silently stops using its index
-- rather than visibly failing to.
--
-- SERVICE_ROLE ONLY, not authenticated and not anon. The drain (Task 6) is
-- the only caller this function will ever have, and a claim reachable by a
-- user session is a way to take work nobody can give back: calling this
-- twice from two browser tabs would mark real recipient rows `claimed`
-- outside of any send actually happening, and nothing un-claims them -- no
-- reclaim exists yet for this table. When one is built it is Task 6's
-- drain's own direct write, not a new RPC: message_campaign_recipients
-- already grants service_role select+update for exactly that shape of write
-- (0242's own grant comment, on settling a send's outcome, claimed_at among
-- the columns it names).
create function public.claim_campaign_batch(p_limit integer)
returns table (
  id                 uuid,
  campaign_id        uuid,
  channel            public.message_channel,
  address            text,
  variables          jsonb,
  attempts           integer,
  company_id         uuid,
  template_name      text,
  template_language  text,
  body               text,
  subject            text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select r.id
    from public.message_campaign_recipients r
    where r.status = 'pending'
      and r.next_attempt_at <= now()
    order by r.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.message_campaign_recipients r
       set status = 'claimed', claimed_at = now()
      from due
     where r.id = due.id
    returning r.id, r.campaign_id, r.channel, r.address, r.variables, r.attempts,
              r.next_attempt_at
  )
  -- LEFT JOIN, not an inner one, on both message_campaigns and
  -- message_templates -- and the reason is structural, not "these might be
  -- missing". The `claimed` CTE above is a data-modifying WITH query, so
  -- PostgreSQL runs its UPDATE unconditionally once, whether or not this
  -- final SELECT's join ends up using every row it returned (the documented
  -- behaviour of a data-modifying CTE, not an assumption about this one). An
  -- INNER JOIN that failed to match would therefore not "not claim" that
  -- row -- the row is already marked claimed by the time the join runs -- it
  -- would silently drop it from what this function RETURNS while leaving it
  -- claimed in the table, exactly the stranding claim_outbox_batch's own
  -- comment (0063) warns an inner join on `integrations` would cause there.
  -- Here that risk is smaller than it was for `integrations` -- campaign_id
  -- and template_id are both NOT NULL with a foreign key, AND neither table
  -- on the other end permits the row to disappear afterwards:
  -- message_campaign_recipients.campaign_id's own comment (0242) says
  -- nothing hard-deletes a message_campaigns row, and
  -- message_campaigns.template_id's own comment (0242) says the identical
  -- thing of message_templates, which is only ever soft-deleted
  -- (deleted_at). Smaller is not zero, and the failure mode a LEFT JOIN
  -- turns into "a claimed row with null template columns the drain must
  -- reject" is strictly more honest than one turned into "a row silently
  -- claimed and never seen again".
  select cl.id, cl.campaign_id, cl.channel, cl.address, cl.variables, cl.attempts,
         c.company_id, t.name, t.language, t.body, t.subject
  from claimed cl
  left join public.message_campaigns c on c.id = cl.campaign_id
  left join public.message_templates t on t.id = c.template_id
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_campaign_batch(integer) from public;
grant execute on function public.claim_campaign_batch(integer) to service_role;

comment on function public.claim_campaign_batch(integer) is
  'The next campaign recipients to send, marked claimed in the same statement that chooses them -- claim_outbox_batch''s shape, read live via pg_get_functiondef rather than trusted from any one migration''s text, since it has been dropped and recreated more than once since it was first written. ONE STATEMENT: pg_cron-driven overlap is the ordinary case for this worker (0063''s own reasoning), and a plain select would let two ticks claim the same rows and send a listener the campaign twice -- the exact complaint that costs a WhatsApp number its quality rating, spec''s own reason this whole block exists. FOR UPDATE SKIP LOCKED so an overlapping call takes the next rows instead of blocking on these. Scans message_campaign_recipients_sendable_idx (0242), partial on `status = ''pending''` alone -- naming `claimed` here too would turn that predicate into a filter applied after the fetch and make the planner''s use of the index depend on table size, the same warning outbox_messages'' own migration (0059) states for the index claim_outbox_batch (0063) scans. Returns attempts UNCHANGED, because claiming is not attempting. LEFT JOINs message_campaigns and message_templates for a reason that is structural rather than "these might be missing": the claim CTE''s UPDATE runs unconditionally as a data-modifying WITH query, so an INNER JOIN that failed to match would silently drop an already-claimed row from what this function returns while leaving it claimed in the table. variables comes back exactly as message_campaign_recipients stores it -- positional, snapshot-time, never re-ordered against message_templates.variables'' current order (0242''s own warning). Does not return from_name, from_email or reply_to (0223): the drain resolves sender identity once per campaign, not once per row, so widening this claim would be the wrong fix for that. GRANTED TO service_role ALONE: the drain (Task 6) is the only caller, and a claim reachable by a user session is a way to take real recipient rows out of circulation that nothing in this block can yet give back -- no reclaim exists for this table yet, and when one is built it is Task 6''s drain''s own direct write, not a new RPC, the same shape 0242''s own grant comment already justifies for settling a send''s outcome.';
