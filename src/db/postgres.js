// Two pools (decision D2): appPgPool is wrapped by ContentionPool and used only by request handlers;
// sysPool is everything else (auth lookups, logging, calibrator, migrations).
import pkg from 'pg'
import { config } from '../config.js'

const { Pool } = pkg

const base = {
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: config.PG_DATABASE,
}

export const appPgPool = new Pool({ ...base, max: config.APP_POOL_SIZE })
export const sysPool = new Pool({ ...base, max: config.SYS_POOL_SIZE })
