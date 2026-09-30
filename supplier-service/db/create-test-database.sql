-- Runs once, when the database container is first created. The API tests empty
-- their database, so they get one of their own and never touch the real data.
CREATE DATABASE supplier_test;
