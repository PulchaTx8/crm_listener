begin;
select plan(6);

-- Block 21 (public legal pages), Task 4. The LGPD deletion request and the
-- protocol a person can read aloud to whoever answers the phone.
--
-- This is deliberately its own table, not contact_requests with a status
-- flag: one is a sales enquiry, the other a statutory obligation with a
-- clock on it, and sharing the table would force the protocol to be the
-- row's uuid -- which nobody can dictate down a telephone, which is the one
-- thing a protocol exists for. See 0188's header for the full argument.

-- ---------------------------------------------------------------------------
-- 1. THE SHAPE. PX-XXXX-XXXX, where each X is drawn from the 32-symbol
--    alphabet with the ambiguous characters already removed.
-- ---------------------------------------------------------------------------
select matches(
  public.new_deletion_protocol(),
  '^PX-[0-9A-Z]{4}-[0-9A-Z]{4}$',
  'the protocol has the PX-XXXX-XXXX shape');

-- ---------------------------------------------------------------------------
-- 2. THE ASSERTION THE WHOLE TABLE EXISTS FOR. A person reads this string
--    down a telephone to somebody who is already upset; O against 0, or I
--    against 1, is the failure that costs them a second call. 200 calls is
--    enough to make "the generator merely usually avoids them" fail loudly.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)
     from (select public.new_deletion_protocol() as p
             from generate_series(1, 200)) calls
    where calls.p ~ '[O0I1]'),
  0::bigint,
  'across 200 calls, no protocol ever contains O, 0, I, or 1');

-- ---------------------------------------------------------------------------
-- 3. Two calls do not collide -- proof the value is generated, not a
--    constant dressed up as one.
-- ---------------------------------------------------------------------------
select isnt(
  public.new_deletion_protocol(),
  public.new_deletion_protocol(),
  'two calls return different protocols');

-- ---------------------------------------------------------------------------
-- 4. THE COLUMN DEFAULT, exercised the way the public form (Task 5) will
--    actually use it: an insert that never mentions `protocol` at all.
-- ---------------------------------------------------------------------------
insert into public.data_deletion_requests (name, email)
values ('Ana Souza', 'ana.souza@example.com');

select matches(
  (select protocol from public.data_deletion_requests where email = 'ana.souza@example.com'),
  '^PX-[0-9A-Z]{4}-[0-9A-Z]{4}$',
  'an insert with no protocol gets a well-formed one from the column default');

-- ---------------------------------------------------------------------------
-- 5. UNIQUE. Not merely "unlikely to collide" (assertion 3) but refused
--    outright if it ever does -- a second person must never be told the
--    first person's protocol is theirs to quote.
-- ---------------------------------------------------------------------------
insert into public.data_deletion_requests (name, email, protocol)
values ('Bruno Lima', 'bruno.lima@example.com', 'PX-2222-3333');

select throws_ok(
  $$insert into public.data_deletion_requests (name, email, protocol)
    values ('Carla Dias', 'carla.dias@example.com', 'PX-2222-3333')$$,
  '23505', null,
  'a duplicate protocol is refused');

-- ---------------------------------------------------------------------------
-- 6. anon MAY NOT READ THIS TABLE. It holds a name, a telephone and an
--    e-mail address -- exactly the row that must never become the public's
--    to browse. Expressed the way 01_identity.test.sql already expresses the
--    same assertion for contact_requests (has_table_privilege against
--    'anon'); no test in this repository expresses a grant assertion any
--    other way, so there was no "no such test" case to fall back from.
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('anon', 'public.data_deletion_requests', 'SELECT'),
  'anon may not read data deletion requests');

select * from finish();
rollback;
