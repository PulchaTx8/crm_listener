-- supabase/migrations/0182_service_hashtags_read.sql

-- Block 19a, Task 8. The read door Task 8's screen calls to show a Station its
-- own two service hashtags.
--
-- widget_installations carries RLS with NO POLICY and its ACL revoked (0159's
-- own comment): every reader is inside a SECURITY DEFINER body, and even the
-- service client is refused with 42501. set_service_hashtags (0177) is the
-- write door; this is the read door it has always needed and never had,
-- because until this task nothing on any screen showed these two columns.

create function public.service_hashtags_for(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.widget_installations%rowtype;
begin
  if not public.has_permission('templates.view', p_company_id) then
    raise exception 'permission denied: templates.view required' using errcode = '42501';
  end if;

  select * into v_row
    from public.widget_installations
   where company_id = p_company_id and deleted_at is null;

  -- A Station with no installation is not an error: the screen shows the two
  -- fields disabled with the reason, and creating an installation is a
  -- console act (0159). `installed` is what tells the two states apart,
  -- since both carry null hashtags.
  if not found then
    return jsonb_build_object('installed', false, 'music', null, 'service', null);
  end if;

  return jsonb_build_object(
    'installed', true,
    'music',     v_row.music_hashtag,
    'service',   v_row.service_hashtag);
end;
$$;

comment on function public.service_hashtags_for is
  'Block 19a, Task 8. Reads the Station''s two service hashtags for the Messages screen, checking templates.view -- widget_installations carries RLS with no policy and its ACL revoked (0159), so nothing outside a SECURITY DEFINER body may read these columns, not even the service client. `installed` distinguishes a Station that has not typed a hashtag yet (installed: true, both null) from one with no widget_installations row at all (installed: false, both null) -- both carry null hashtags, and only this flag tells the screen which reason to show.';

revoke execute on function public.service_hashtags_for(uuid) from public, anon;
grant execute on function public.service_hashtags_for(uuid) to authenticated;
