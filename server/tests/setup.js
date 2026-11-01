// Runs in every test worker before modules load.
import { testDatabaseUrl } from './globalSetup.js';

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || testDatabaseUrl();
