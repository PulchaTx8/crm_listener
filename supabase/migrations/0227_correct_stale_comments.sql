-- supabase/migrations/0227_correct_stale_comments.sql

-- Block 29b-1, whole-branch review (F25). Two comments this block made FALSE,
-- both living in migrations that are already merged and deployed and therefore
-- may not be edited in place.
--
-- A comment that states something false is not a smaller defect than false
-- code: it is the thing the next reader trusts INSTEAD of reading the code, and
-- the table comment below is the sentence this block's own spec quotes as its
-- authority for what message_templates holds.
--
-- `comment on` REPLACES rather than appends, so each statement below carries
-- the still-true half of the live text forward verbatim. Anything omitted here
-- is deleted from the catalogue. The live text was read out of pg_description
-- before this file was written, not copied from 0110 and 0165 on the assumption
-- that nothing between had replaced it -- 0113 does comment on
-- register_message_template, and 0165's is the one that actually survived.

-- ---------------------------------------------------------------------------
-- 1. The table. "One approved template per (company_id, purpose)" was true of
-- every row until 0225, and is false of every marketing row now: a marketing
-- template HAS no purpose, and a Station holds as many of them as an operator
-- writes.
--
-- The second and third sentences (the missing status column, and why) are
-- carried forward word for word -- they are as true of an email campaign as of
-- a WhatsApp registration, and the warning they end on is the part somebody
-- would otherwise undo.
-- ---------------------------------------------------------------------------
comment on table public.message_templates is
  'Two families since 0223, told apart by `purpose`. A SYSTEM template names one, is REGISTERED after Meta approves it out of band, and there is at most one live row per (company_id, purpose) -- message_templates_purpose_unique, partial on `purpose is not null` since 0223. A MARKETING template has a NULL purpose, is written by an operator rather than transcribed from Meta, carries no such limit, and may be WhatsApp or EMAIL (`channel`). Deliberately has no status column (spec §3.2): this system records what the operator was told at registration and cannot know whether Meta still approves it, so a status here would look like live truth and would actually be a memory. A revoked approval is discovered by the first rejected send, not by reading a column — do not add one without addressing that.';

-- ---------------------------------------------------------------------------
-- 2. register_message_template. Its comment still called p_variables "variable
-- descriptions" -- prose, which is what the parameter held until 0223 retyped
-- the column to template_variable[] -- and named neither `channel` nor
-- `internal_name`, two columns this door now fills without taking a parameter
-- for either. A reader planning a caller would have missed both.
--
-- Everything 0165 said about p_otp_button is carried forward verbatim: it is
-- still exactly true, and it is the sentence that records why the widget
-- stopped delivering codes in production.
-- ---------------------------------------------------------------------------
comment on function public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb, boolean) is
  'Records a template Meta has already approved, or replaces the one recorded for that purpose. Registers only — it does not submit anything to Meta (D4), which is why the name and language are transcribed rather than chosen. Writes `channel` fixed at WHATSAPP (a system purpose is never email) and `internal_name` reused from p_name (a system card is titled by its purpose and has no second label to give), neither of which it takes a parameter for: widening the signature would drop the ACL for a field nobody would fill. Stamps `updated_by` from auth.uid() on the insert and on every re-registration. p_variables is a jsonb array of NAMES from the template_variable vocabulary (0222) since 0223, not the prose descriptions it held before -- it stays jsonb rather than becoming template_variable[] so the signature, and with it the grant, survives `create or replace`; it is cast inside, and an element that is not a string, or is outside the vocabulary, is refused 22023 by name. Refuses a body whose {{n}} count disagrees with the number of variables named: 0111 makes the identical comparison at send time, where the only reader is a server log, so the same mistake is caught here as a form error instead. Since 0165 it also records p_otp_button, transcribed from the same Meta approval screen: an authentication template carries an OTP button whose parameter must be named on the wire, and a send that omits it is refused with (#131008) Required parameter is missing -- the defect that stopped the Block 17a widget delivering any verification code in production. Refuses 22023 when p_otp_button is given for a body with no placeholder, because the button''s parameter is the code that placeholder would have held.';
