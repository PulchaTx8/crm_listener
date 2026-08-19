create type public.campaign_status as enum (
  'queued',
  'running',
  'sent',
  'failed',
  'cancelled'
);

-- SUPPRESSED IS ITS OWN OUTCOME. A campaign recipient's failure is our problem
-- and earns a retry; a listener's withdrawal from marketing consent is their
-- choice and must never be retried. A counter that added failed and suppressed
-- together would hide the one fact an operator must see.
create type public.campaign_recipient_status as enum (
  'pending',
  'claimed',
  'sent',
  'failed',
  'suppressed',
  'cancelled'
);
