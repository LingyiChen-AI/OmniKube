import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;
// Force UTC session timezone: timestamp columns store wall-clock time written
// by now()/defaultNow() in the session timezone, while drizzle always reads
// them back as UTC. A non-UTC server default (e.g. Asia/Shanghai) skews every
// timestamp by the offset (issue #4).
const client = postgres(connectionString, { connection: { TimeZone: 'UTC' } });
export const db = drizzle(client, { schema });
