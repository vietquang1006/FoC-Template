-- The status is a fixed set, so the database rejects anything else. The type is
-- free text on purpose: it starts as the types in the seed file (Food, Shopping,
-- Printing, ...) and administrators can introduce new ones.
CREATE TYPE supplier_status AS ENUM ('Active', 'Inactive');

CREATE TABLE suppliers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  type        TEXT NOT NULL CHECK (char_length(type) BETWEEN 1 AND 60),
  zone        TEXT NOT NULL CHECK (char_length(zone) BETWEEN 1 AND 60),
  building    TEXT NOT NULL CHECK (char_length(building) BETWEEN 1 AND 120),
  address     TEXT NOT NULL CHECK (char_length(address) BETWEEN 1 AND 200),
  description TEXT CHECK (char_length(description) <= 500),
  latitude    DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude   DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  phone       TEXT,
  email       TEXT,
  status      supplier_status NOT NULL DEFAULT 'Active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Account identifiers from the User Service. Null for the seeded suppliers.
  created_by  TEXT,
  updated_by  TEXT,
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

-- One row per weekday the supplier is open. A weekday with no row is closed all
-- day. Times are minutes after local midnight, so that "24:00" can be stored
-- exactly. closes_minute below opens_minute means the window runs past midnight.
CREATE TABLE supplier_hours (
  supplier_id   UUID NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_minute  SMALLINT NOT NULL CHECK (opens_minute BETWEEN 0 AND 1439),
  closes_minute SMALLINT NOT NULL CHECK (closes_minute BETWEEN 1 AND 1440),
  PRIMARY KEY (supplier_id, weekday),
  CHECK (opens_minute <> closes_minute)
);

-- Listing is sorted by name and usually limited to Active suppliers.
CREATE INDEX suppliers_status_name_idx ON suppliers (status, lower(name), id);
CREATE INDEX suppliers_type_idx ON suppliers (lower(type));
CREATE INDEX suppliers_zone_idx ON suppliers (lower(zone));
