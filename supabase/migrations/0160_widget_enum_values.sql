-- supabase/migrations/0160_widget_enum_values.sql

-- Block 17a. TWO ADD VALUEs AND NOTHING ELSE IN THIS FILE.
--
-- The Postgres rule 0082, 0091 and 0151 each paid for: ALTER TYPE ... ADD VALUE
-- cannot share a transaction with a statement that USES the value. Separate
-- files are separate transactions. The two below may share this one because
-- neither uses the other's value; 0161 uses both, and is a separate file.

alter type public.template_purpose add value 'WEB_VERIFICATION';

alter type public.member_consent_type add value 'identification';

comment on type public.member_consent_type is
  'What a Member agreed to, or withdrew, at a Station. `rules` is agreement to a promotion''s rules; `identification` is Block 17a''s -- the basis for holding a name and a telephone number typed into a Station''s own website, recorded with origin = ''web-widget'' so an audit can tell it apart from a number that arrived over WhatsApp. Append-only since 0032: a withdrawal is a new row.';
