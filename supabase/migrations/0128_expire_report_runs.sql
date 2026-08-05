-- supabase/migrations/0128_expire_report_runs.sql

-- Block 8b, Task 9: making the expiry true.
--
-- THE FACT THAT SHAPES THIS FILE is 0087's, and it has not changed: deleting a
-- row in SQL removes the METADATA and leaves the file in the backing store. An
-- expiry written in SQL alone would look complete and would not be, which is
-- worse than one that visibly fails. So this clears the reference and records
-- the instruction, in one transaction per run, and the worker tick's existing
-- drain (0087, src/lib/storage/erasure.ts) carries it out through the storage
-- API -- the only thing that can actually delete the bytes.
--
-- THE ORDER INSIDE THE LOOP MATTERS AND IS NOT INTERCHANGEABLE. The queue row
-- is written and the path cleared in the SAME transaction, so the intent cannot
-- survive without the instruction. Clearing the path first and failing before
-- the insert would leave a file nobody can reach and nobody will ever delete --
-- the worst of both outcomes, and invisible.
--
-- A PROCEDURE, CARRYING NEITHER `security definer` NOR `set search_path`, and
-- that is not a style choice: 0094's header records the proof. Postgres refuses
-- transaction control inside either -- a bare `commit;` in a procedure declared
-- with only one of them raises `invalid transaction termination` -- because
-- both make it wrap the call in a save/restore guard around the role or the
-- GUC, and that guard is incompatible with the COMMIT being the sole top-level
-- statement. There is no workaround. Every reference below is therefore
-- schema-qualified by hand, exactly as 0094 and 0112 qualify theirs.
--
-- COMMIT PER RUN, for 0094's reason: the sweep is global, across every Station
-- in the installation, and one row that cannot be written must not roll back
-- every other expiry, every day, for ever.

create procedure public.expire_report_runs()
language plpgsql
as $$
declare
  v_run     record;
  v_expired integer := 0;
  v_failed  integer := 0;
begin
  for v_run in
    select r.id, r.storage_path
      from public.report_runs r
     where r.storage_path is not null
       and r.expires_at is not null
       and r.expires_at <= now()
     order by r.expires_at
  loop
    begin
      insert into public.storage_erasure_queue (bucket, path)
      values ('reports', v_run.storage_path);

      update public.report_runs
         set storage_path = null
       where id = v_run.id;

      commit;
      v_expired := v_expired + 1;
    exception when others then
      rollback;
      v_failed := v_failed + 1;
      raise warning 'report expiry failed for run %: %', v_run.id, sqlerrm;
    end;
  end loop;

  if v_expired = 0 and v_failed = 0 then
    raise notice 'report expiry: nothing due';
  else
    raise notice 'report expiry: % expired, % failed', v_expired, v_failed;
  end if;
end;
$$;

comment on procedure public.expire_report_runs() is
  'Sends every report file older than its seven days to storage_erasure_queue and clears the run''s storage_path, in one transaction per run. The queue row and the cleared path are written together so the intent cannot survive without the instruction: clearing the path alone would leave a file nobody can reach and nobody will delete. The HISTORY row survives -- who exported what, when, and how many rows -- because that is the audit record this block contributes, and it must not expire with the bytes.';

-- 17 past the hour rather than on it, so this does not contend with every other
-- installation's midnight-and-on-the-hour jobs -- and at 03:17, because an
-- expiry is not urgent and the storage API calls it queues are cheapest when
-- nobody is exporting.
select cron.schedule(
  'expire-report-runs',
  '17 3 * * *',
  $$ call public.expire_report_runs(); $$
);
