-- Account deletion must be able to cascade through currencies_ledger. The ledger
-- stays append-only for everything else: only rows of the user named by the
-- transaction-local `tumble.erase_user` setting may be deleted, and never updated.
CREATE OR REPLACE FUNCTION currencies_ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.user_id::text = current_setting('tumble.erase_user', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'currencies_ledger is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
