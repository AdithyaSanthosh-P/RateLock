// Applies schemas/migrations/*.sql in name order, once each. Usage: npm run migrate
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from 'pg'
import { config } from '../src/config.js'

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'migrations')

const client = new pkg.Client({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: config.PG_DATABASE,
})

async function main() {
    await client.connect()
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz DEFAULT now())')

    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map(r => r.id))
    const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()

    let applied = 0
    for (const file of files) {
        if (done.has(file)) continue
        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8')
        try {
            await client.query('BEGIN')
            await client.query(sql)
            await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file])
            await client.query('COMMIT')
            console.log(`applied ${file}`)
            applied++
        } catch (err) {
            await client.query('ROLLBACK')
            throw new Error(`migration ${file} failed: ${err.message}`)
        }
    }
    if (applied === 0) console.log('nothing to apply')
}

main()
    .catch(err => { console.error(err.message); process.exitCode = 1 })
    .finally(() => client.end())
