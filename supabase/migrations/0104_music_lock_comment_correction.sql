-- supabase/migrations/0104_music_lock_comment_correction.sql

-- One sentence, and it is not cosmetic.
--
-- 0103 replaced a false claim on archive_music_reference with a true account of
-- the lock pair, and introduced a smaller error of its own while doing it. The
-- comment it wrote says FOR KEY SHARE "is the one mode FOR UPDATE conflicts
-- with". That is backwards. FOR UPDATE conflicts with ALL FOUR row-lock modes;
-- it is FOR KEY SHARE that has exactly one conflict, and that conflict is FOR
-- UPDATE. 0103's file header and its comment on assert_song_references_live
-- both state it correctly — only this one sentence inverts it.
--
-- Why a migration rather than leaving it: the sentence points at a real way to
-- reopen the race. Someone reading "FOR UPDATE conflicts with [only] FOR KEY
-- SHARE" could reasonably weaken archive_music_reference's FOR UPDATE to FOR
-- SHARE, believing the pair still holds. It would not. FOR SHARE does NOT
-- conflict with FOR KEY SHARE, so the archiver and a concurrent create_song
-- would stop serialising and the interleaving 0103 closed would come back —
-- silently, with both functions still carrying comments that say they are safe.
-- That is the same shape of defect 0103 was written to fix, one level down.
--
-- Nothing executable changes here. Both locks stay exactly as 0100 and 0103 set
-- them; this migration only makes the sentence describing them true.

comment on function public.archive_music_reference(public.music_reference_kind, uuid) is
  'Soft-deletes a genre, label, artist or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 7b''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row before counting; that excludes a concurrent create_song only because 0103 makes assert_song_references_live take FOR KEY SHARE on the same row, and FOR KEY SHARE conflicts with FOR UPDATE and with nothing weaker. The two locks are a pair and neither works alone: until 0103 the reader took no lock, so an archive and a create could interleave and leave a live song naming an archived reference. Do not weaken this FOR UPDATE — FOR SHARE does not conflict with FOR KEY SHARE, so that change would reopen the race while both comments still claimed it was closed.';
