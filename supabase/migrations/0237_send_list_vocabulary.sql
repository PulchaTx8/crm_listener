-- supabase/migrations/0237_send_list_vocabulary.sql

-- Block 29d-1. The two enums a send list is built from: SOURCE, which listing
-- it was cut from, and KIND, FIXED or LIVING (spec D2).
--
-- This pair would in fact be legal beside 0238's table that uses them --
-- CREATE TYPE followed by a table naming that type in the same transaction is
-- not the case Postgres refuses; that restriction belongs to ALTER TYPE ...
-- ADD VALUE on an ENUM THAT ALREADY EXISTS (0209 draws the same contrast for
-- RENAME VALUE). It travels alone anyway, on the house convention since 0192
-- and again at 0209: enum vocabulary lands in a file that does nothing else,
-- so there is one rule to remember rather than a rule and an exception.

create type public.send_list_source as enum ('members', 'participations', 'requests');
create type public.send_list_kind as enum ('fixed', 'living');
