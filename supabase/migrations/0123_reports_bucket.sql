-- supabase/migrations/0123_reports_bucket.sql

-- Block 8b, Task 4: where a generated file lives.
--
-- 0086's shape, for 0086's reasons: the bucket is private, so a path is not a
-- link. The client asks for a short-lived signed URL at the moment of the
-- click, and it is never stored anywhere.
--
-- WHERE THIS DEPARTS FROM 0086, AND WHY IT IS STRONGER. A delivery receipt has
-- no row of its own, so 0086 must prove the Station from the object path --
-- storage.foldername(name)[1] cast to uuid -- and then ask has_permission about
-- it. A report object DOES have a row: exactly one report_runs row names it in
-- storage_path. So the policy matches on that instead, and inherits
-- report_runs' own RLS (0122) through the subquery, which is evaluated as the
-- querying role. The rule "may this caller see this run" is then written once,
-- in one place, and an object cannot be reached through any run except the one
-- that produced it.
--
-- The path is still {company_id}/{run_id}.{ext}, because a bucket a human may
-- have to inspect during an incident should be legible. A consolidated run
-- files under its FIRST Station id -- a filing decision, not a permission one:
-- the permission is carried by the run row, which names every Station, and
-- 0127 refuses a consolidated request without reports.consolidated in all of
-- them.

insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

create policy reports_read_own_run
  on storage.objects for select to authenticated
  using (
    bucket_id = 'reports'
    and exists (
      select 1 from public.report_runs r
      -- objects.name, qualified: report_runs has no `name` column today, so a
      -- bare reference would correlate correctly by accident. If one is ever
      -- added, an unqualified `name` would silently rebind to it and this
      -- policy would compare a path against something else entirely.
      where r.storage_path = objects.name
    )
  );

-- No `comment on policy` here, and its absence is not an oversight: COMMENT
-- requires ownership of the relation, and the migration role owns
-- public.report_runs but not storage.objects -- it may only add policies to it.
-- 0086 carries no comment on its two receipt policies for the same reason. So
-- the policy's reasoning stays in this header:
--
-- A report object is readable exactly when its run row is. The EXISTS reaches
-- report_runs, whose own RLS (0122) already answers "may this caller see this
-- run", so the rule lives in one place rather than being restated against the
-- object path. A run whose storage_path has been cleared by expiry (0128)
-- matches nothing here -- which is what makes an expired file unreadable even
-- to somebody who kept its path.

-- No INSERT, UPDATE or DELETE policy for authenticated, deliberately. Writing
-- is the worker's, through service_role, which bypasses RLS; deletion is the
-- storage erasure queue's (0087), through the same client. A client that could
-- write here could place a file at a path a signed URL would later be minted
-- for.
