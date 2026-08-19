-- supabase/migrations/0236_messaging_permissions.sql

-- Block 29d-1, Task 1: the three permissions that guard send lists and, later,
-- campaigns. Born beside the feature they guard, which is 0010's own rule.
--
-- SEND IS SEPARATE FROM MANAGE, and that is the whole reason there are three
-- rather than two: approving a send to twenty thousand people is not the act of
-- drafting one, and a Station may want those in different hands.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('messaging.view',   'See filtered listings and build send lists',     '29d-1', 'messaging', 'See send lists',           'company', 10),
  ('messaging.manage', 'Create and edit send lists',                     '29d-1', 'messaging', 'Create send lists',        'company', 20),
  ('messaging.send',   'Approve and send campaigns',                     '29d-1', 'messaging', 'Approve sends',            'company', 30);
