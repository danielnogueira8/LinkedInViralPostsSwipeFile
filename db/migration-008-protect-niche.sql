-- Belt-and-suspenders: prevent any UPDATE from wiping a non-null niche to NULL.
-- Sheet sync, future scripts, or buggy code can no longer accidentally blank niches.
-- An explicit clear still works via the manual-entry route (which passes the value
-- through INSERT ... ON CONFLICT and supplies its own UPDATE path), or by dropping
-- the trigger temporarily for a deliberate cleanup.

create or replace function protect_account_niche()
returns trigger
language plpgsql
as $$
begin
  if old.niche is not null and new.niche is null then
    new.niche := old.niche;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_account_niche_trg on accounts;

create trigger protect_account_niche_trg
before update on accounts
for each row
execute function protect_account_niche();
