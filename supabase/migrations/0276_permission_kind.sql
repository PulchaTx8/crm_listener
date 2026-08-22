-- supabase/migrations/0276_permission_kind.sql

-- WHICH PERMISSIONS ARE READS, as data rather than as a list inside a function.
--
-- 0277 uses this to decide what an Organization's users may do at a Station of
-- their group (design D19): everything that reads, nothing that writes. Written
-- as a list inside that function instead, it would drift the first time a block
-- adds a permission and nobody remembers to classify it -- and the drift is
-- silent in the worst direction, because an unclassified code would fall into
-- whichever branch the list's default happened to be.
--
-- NOT NULL IN THIS SAME MIGRATION, unlike members.person_id in 0275. There the
-- constraint had to wait for a backfill over live rows written by doors that did
-- not know about it. Here the classification is complete by construction: the
-- catalogue has forty-three rows, the two statements below name all forty-three,
-- and a forty-fourth cannot arrive until some future migration inserts one -- at
-- which point this constraint is exactly the reminder that migration needs.
create type public.permission_kind as enum ('READ', 'WRITE');

alter table public.permissions add column kind public.permission_kind;

-- The reads. Everything that shows somebody something and changes nothing.
--
-- reports.consolidated is here deliberately, and it is the one that a rule of
-- thumb would have got wrong. Matching on ".view" would have been shorter and
-- would have classified as a WRITE the single most group-shaped permission in
-- the product -- the one gating the dashboard's Station pills (0115, 0118),
-- which is reading numbers across a group and is the reason D19 exists at all.
update public.permissions set kind = 'READ' where code in (
  'audit.view',
  'inventory.view',
  'members.view',
  'messaging.view',
  'music.view',
  'participations.view',
  'promotions.view',
  'reports.consolidated',
  'templates.view'
);

-- EVERYTHING ELSE, by fallback rather than by list, and that direction is the
-- decision. A code this file failed to think about lands in WRITE, which is the
-- side that withholds. Enumerating the writes instead would have put the
-- forgotten one in READ, and a permission nobody classified would have become
-- exercisable by every group owner on the platform without a line of code
-- changing anywhere.
update public.permissions set kind = 'WRITE' where kind is null;

alter table public.permissions alter column kind set not null;

comment on column public.permissions.kind is
  'Whether exercising this permission changes a Station''s operational state. READ is what an Organization''s users may do at a Station of their group; WRITE is what they may not (design D19, enforced in has_permission_for since 0277). A permission inserted without a kind cannot exist, and that is the point: the constraint is the reminder, and anything that slipped past it would silently become exercisable by every group owner on the platform.';
