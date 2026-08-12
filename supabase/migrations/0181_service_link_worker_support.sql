-- supabase/migrations/0181_service_link_worker_support.sql

-- Block 19a, Task 5. Two small doors the worker needs that no earlier task in
-- this block produced, both discovered while wiring sendServiceLink and
-- neither changing a migration already shipped and reviewed (0178, 0179):
--
-- 1. finish_whatsapp_turn's whitelist. It closes "an inbound event whose
--    decision was taken in Node" (0070's own words) and today only knows five
--    outcomes, none of them a link. A link intent is exactly the same kind of
--    thing -- a decision Node made about a message -- so it is added to the
--    SAME door rather than growing a second one that would duplicate
--    finish_whatsapp_event's write and audit-log call for no reason.
--
-- 2. widget_link_send_context(company_id). mint_widget_link (0178) returns
--    only the raw code -- by design, D2's window means it cannot also hand
--    back a public_key on the window's null path, and 0178 is not reopened
--    for it. But buildServiceLink (Task 4) needs the installation's
--    public_key to address the URL, and widget_installations has its ACL
--    revoked (0159): "every reader is inside a SECURITY DEFINER body". This
--    is that body, and it returns the Station's system-message overrides in
--    the same call for the same reason whatsapp_prompt_context (0114) bundles
--    promotion and systemMessages -- one round trip, not two.

create or replace function public.finish_whatsapp_turn(p_event_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_outcome not in ('conversation', 'conversation_turn', 'refused',
                       'abandoned', 'no_conversation',
                       -- Block 19a: a link intent minted a code and enqueued
                       -- the one message that carries it, or minted nothing
                       -- because D2's two-minute window already answered this
                       -- listener for this purpose and the door said say
                       -- nothing. Neither carries a participation, exactly
                       -- like the five above.
                       'link_sent', 'already_answered') then
    raise exception 'not an outcome a turn may write: %', p_outcome
      using errcode = '22023';
  end if;

  return public.finish_whatsapp_event(p_event_id, p_outcome, null, null);
end;
$$;

comment on function public.finish_whatsapp_turn(uuid, text) is
  'Closes an inbound event whose decision was taken in Node: a conversation opened, a turn taken, a refusal, an abandonment, a message from somebody who is not mid-conversation, or (Block 19a) a link intent sent or withheld by D2''s window. The whitelist is the point -- an outcome carrying a participation is written by complete_whatsapp_conversation inside the transaction that writes the entry, so the two cannot disagree, and this door cannot be used to claim one happened. Everything else about the row is finish_whatsapp_event''s (0062), which stays private.';

create or replace function public.widget_link_send_context(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations%rowtype;
begin
  select * into v_install
    from public.widget_installations
   where company_id = p_company_id
     and enabled
     and deleted_at is null;

  if not found then
    -- Matches mint_widget_link's own refusal (0178): reached moments after
    -- that call already required the same row to exist, so this is a
    -- Station switched off mid-request rather than an ordinary path, and the
    -- caller has nothing more useful to do with it than propagate.
    raise exception 'this Station has no live widget installation' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'publicKey', v_install.public_key,
    -- This Station's own wording, per text (D2) -- the same query
    -- whatsapp_prompt_context runs, scoped by company_id directly rather
    -- than through a promotion, because a MUSIC or MENU link names none.
    'systemMessages', coalesce((
      select jsonb_object_agg(t.key::text, t.body)
      from public.station_message_templates t
      where t.company_id = p_company_id
        and t.deleted_at is null), '{}'::jsonb)
  );
end;
$$;

revoke execute on function public.widget_link_send_context(uuid) from public, anon, authenticated;
grant execute on function public.widget_link_send_context(uuid) to service_role;

comment on function public.widget_link_send_context(uuid) is
  'Block 19a. What sendServiceLink needs and mint_widget_link (0178) does not carry: the installation''s public_key, so buildServiceLink can address the URL, and this Station''s own wording for the three LINK_* texts (D2, same per-text/per-Station rule as whatsapp_prompt_context). SECURITY DEFINER because widget_installations has its ACL revoked (0159) -- every reader is inside a body like this one. Raises P0002 when the Station has no live installation, mirroring mint_widget_link''s own refusal for the same condition; reachable only if the installation was switched off in the moments between the two calls, since sendServiceLink calls this only after a successful mint. Granted to service_role only: the caller is the worker.';
