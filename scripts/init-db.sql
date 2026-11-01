-- Runs once when the Docker volume is first created.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Separate database for the automated test suite (reset on every test run).
CREATE DATABASE umkm_saham_test;
