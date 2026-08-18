-- supabase/migrations/0237_send_list_vocabulary.sql

-- Block 29d-1. The two enums a send list is built from: SOURCE, which listing
-- it was cut from, and KIND, FIXED or LIVING (spec D2). Split into their own
-- migration, alone, because Postgres refuses a value of a type in the same
-- transaction that created the type, and 0238's table needs both the moment
-- it opens.

create type public.send_list_source as enum ('members', 'participations', 'requests');
create type public.send_list_kind as enum ('fixed', 'living');
