-- One immutable configuration snapshot per version, not per passage.
CREATE TABLE vehicle_watchlist_versions (
 version integer PRIMARY KEY CHECK(version>0),
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vehicle_watchlist_versions(version,document,created_at)
 SELECT version,document,updated_at FROM vehicle_preparation WHERE id='watchlist';
CREATE FUNCTION retain_vehicle_watchlist_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id='watchlist' THEN
  INSERT INTO vehicle_watchlist_versions(version,document) VALUES(NEW.version,NEW.document);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vehicle_watchlist_version AFTER INSERT OR UPDATE ON vehicle_preparation
 FOR EACH ROW EXECUTE FUNCTION retain_vehicle_watchlist_version();
