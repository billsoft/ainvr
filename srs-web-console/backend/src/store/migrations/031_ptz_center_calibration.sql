CREATE TABLE ptz_calibration_epochs (
  motor text PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);

CREATE TABLE ptz_center_calibrations (
  motor text NOT NULL REFERENCES ptz_calibration_epochs(motor) ON DELETE CASCADE,
  scope text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (motor, scope)
);
