-- currencies_ledger is append-only: corrections are new compensating rows, never edits.
CREATE OR REPLACE FUNCTION currencies_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'currencies_ledger is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER currencies_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON currencies_ledger
  FOR EACH ROW EXECUTE FUNCTION currencies_ledger_append_only();
