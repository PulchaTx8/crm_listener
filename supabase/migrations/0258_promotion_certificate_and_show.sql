-- supabase/migrations/0258_promotion_certificate_and_show.sql

-- Block 30c, items 10 and 17. Two things a promotion can now record: the number
-- of the authorisation that licenses it, and the Programme it belongs to.
--
-- NEITHER IS USED BY ANY RULE IN THIS BLOCK. The certificate is shown and
-- stored; the Programme is stored so Block 30e can bound a participation window
-- by its schedule, which is what the owner's item 17 says in as many words
-- ("It will be used later for filtering and eligibility"). Recording that here
-- so the next reader does not go looking for the logic.

alter table public.promotions
  add column authorization_certificate text,
  add column show_id                   uuid;

-- NO UNIQUE INDEX, and that is a decision rather than an omission (D1).
-- site_integration_code carries one (0040) because this system issues it. The
-- certificate number is issued OUTSIDE this system, which has no way to know
-- whether two promotions sharing one is a mistake or one licence covering both
-- -- and a unique index would turn a question about paperwork into a save that
-- fails with a message the operator cannot act on.
comment on column public.promotions.authorization_certificate is
  'The number of the authorisation that licenses this promotion, as the operator transcribes it. Free text, optional, and deliberately NOT unique: it is issued outside this system, so two promotions covered by one licence are a legitimate shape here. Never validated against a format -- if one is ever required, it is a rule somebody outside this system owns.';

-- COMPOSITE, so a cross-Station reference is unrepresentable rather than merely
-- unlikely -- the device promotion_questions (0041) and promotions' own
-- company/organization FK already use. shows already carries the matching
-- shows_id_company_unique (id, company_id), so this needs no new index.
--
-- NO ON DELETE ACTION, and none is needed: shows is soft-deleted through
-- deleted_at (0098), so a Programme is never actually removed for a rule to
-- fire on. A promotion keeps pointing at an archived Programme on purpose (D3)
-- -- a promotion that ran inside a Programme ran inside it whether or not the
-- Programme is still on air, and the screen says "archived" beside the name
-- rather than implying it is still scheduled. Same treatment list_music_requests
-- gives an archived song, and for the reason 0101 gives: a historical fact
-- outlives the thing it names.
alter table public.promotions
  add constraint promotions_show_fk
  foreign key (show_id, company_id) references public.shows (id, company_id);

comment on column public.promotions.show_id is
  'The Programme this promotion belongs to, or null. Optional. Survives the Programme being archived (shows.deleted_at) rather than being cleared, so that a promotion which ran inside a Programme still says so and Block 30e can still read that Programme''s schedule. The FK is composite on (show_id, company_id) so a Programme from another Station cannot be attached.';
