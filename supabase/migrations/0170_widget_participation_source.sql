-- supabase/migrations/0170_widget_participation_source.sql

-- Block 17c. ONE ADD VALUE AND NOTHING ELSE IN THIS FILE.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with a statement that
-- USES the value. Separate files are separate transactions, and 0171 uses this
-- one. 0082, 0091, 0151, 0160 and 0166 each paid for this rule.

alter type public.participation_source add value 'WEB';

comment on type public.participation_source is
  'How an entry reached this product. MANUAL is an operator recording it; IMPORT is the legacy migration; WHATSAPP is this product''s own bot; WEB is Block 17c -- a listener standing on the Station''s own website, through the embedded widget. It is also the source stamped on a promotion_refusals row, so a refusal carries the door it came through rather than only the fact of it.';
