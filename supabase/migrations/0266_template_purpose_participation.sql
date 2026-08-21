-- supabase/migrations/0266_template_purpose_participation.sql

-- Block 30d, D9. One purpose per answer apply_participation can give, because
-- the four sentences carry different variables -- a single template whose body
-- is nearly all placeholder is the shape Meta rejects.
--
-- ALONE IN THIS FILE, AND THAT IS THE POINT. Supabase runs each migration in
-- its own transaction, and a value added by `alter type ... add value` cannot
-- be USED in the transaction that added it. 0267 is where they are used.
alter type public.template_purpose add value if not exists 'PARTICIPATION_CONFIRMED';
alter type public.template_purpose add value if not exists 'PARTICIPATION_DUPLICATE';
alter type public.template_purpose add value if not exists 'PARTICIPATION_TOO_SOON';
alter type public.template_purpose add value if not exists 'PARTICIPATION_OVER_LIMIT';
