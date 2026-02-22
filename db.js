const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL Database Connection Pool
 *
 * Supports DATABASE_URL (for Render, Heroku, etc.) or individual connection parameters
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});

module.exports = pool;

// --- PostgreSQL Database Schema ---
/**
 * SQL Schema array for setting up the necessary tables,
 * indexes, stored procedures (functions), and triggers for the FPL/F1 application.
 *
 * To execute these, loop through this array using a database client library like 'pg'.
 */
const SQL_SCHEMA = [
    // 1. --- TABLES (CORE) ---

    // USERS Table
    `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        fpl_team_id VARCHAR(50),
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        verification_token VARCHAR(500),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );`,

    // USERS_HISTORY Table (Audit Log)
    `CREATE TABLE IF NOT EXISTS users_history (
        history_id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        action_type VARCHAR(10) NOT NULL,
        old_data JSONB,
        new_data JSONB NOT NULL,
        changed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );`,

    // F1_LEAGUE Table
    `CREATE TABLE IF NOT EXISTS F1_LEAGUE (
        league_id SERIAL PRIMARY KEY,
        fpl_league_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        current_gameweek INT NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        setup_timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );`,

    // F1_CONSTRUCTORS Table
    `CREATE TABLE IF NOT EXISTS F1_CONSTRUCTORS (
        constructor_id SERIAL PRIMARY KEY,
        league_id INT NOT NULL REFERENCES F1_LEAGUE(league_id),
        f1_team_name VARCHAR(100) UNIQUE NOT NULL,
        logo_url TEXT,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );`,

    // F1_DRIVER_ASSIGNMENTS Table
    `CREATE TABLE IF NOT EXISTS F1_DRIVER_ASSIGNMENTS (
        assignment_id SERIAL PRIMARY KEY,
        league_id INT NOT NULL REFERENCES F1_LEAGUE(league_id),
        user_id INT NOT NULL REFERENCES users(id),
        constructor_id INT NOT NULL REFERENCES F1_CONSTRUCTORS(constructor_id),
        driver_role VARCHAR(10) NOT NULL CHECK (driver_role IN ('Driver A', 'Driver B')),
        UNIQUE (league_id, user_id),
        UNIQUE (constructor_id, driver_role)
    );`,

    // F1_CHIP_USAGE Table
    `CREATE TABLE IF NOT EXISTS F1_CHIP_USAGE (
        usage_id SERIAL PRIMARY KEY,
        league_id INT NOT NULL REFERENCES F1_LEAGUE(league_id),
        user_id INT NOT NULL REFERENCES users(id),
        gameweek INT NOT NULL,
        chip_type VARCHAR(20) NOT NULL CHECK (chip_type IN ('Safety Car', 'DRS Boost')),
        UNIQUE (league_id, user_id, chip_type)
    );`,

    // F1_GW_STATS Table
    `CREATE TABLE IF NOT EXISTS F1_GW_STATS (
        gw_stat_id SERIAL PRIMARY KEY,
        league_id INT NOT NULL REFERENCES F1_LEAGUE(league_id),
        user_id INT NOT NULL REFERENCES users(id),
        gameweek INT NOT NULL,
        raw_fpl_score INT NOT NULL,
        transfer_hits INT NOT NULL,
        fpl_chip_used VARCHAR(30),
        is_race_gw BOOLEAN NOT NULL,
        qual_gw_rank INT,
        grid_fpl_bonus INT NOT NULL DEFAULT 0,
        net_fpl_score DECIMAL(10, 2) NOT NULL,
        used_safety_car BOOLEAN NOT NULL DEFAULT FALSE,
        used_drs_boost BOOLEAN NOT NULL DEFAULT FALSE,
        weekly_league_rank INT NOT NULL,
        base_f1_points DECIMAL(10, 2) NOT NULL,
        pole_position_f1_bonus DECIMAL(10, 2) NOT NULL DEFAULT 0,
        dotd_f1_bonus DECIMAL(10, 2) NOT NULL DEFAULT 0,
        final_f1_points DECIMAL(10, 2) NOT NULL,
        UNIQUE (league_id, user_id, gameweek)
    );`,

    // F1_STANDINGS Table
    `CREATE TABLE IF NOT EXISTS F1_STANDINGS (
        standing_id SERIAL PRIMARY KEY,
        league_id INT NOT NULL REFERENCES F1_LEAGUE(league_id),
        gameweek INT NOT NULL,
        user_id INT REFERENCES users(id),
        constructor_id INT REFERENCES F1_CONSTRUCTORS(constructor_id),
        cumulative_f1_points DECIMAL(10, 2) NOT NULL,
        cumulative_fpl_points INT NOT NULL,
        current_rank INT NOT NULL,
        rank_1st_place_count INT NOT NULL DEFAULT 0,
        rank_2nd_place_count INT NOT NULL DEFAULT 0,
        CHECK ((user_id IS NOT NULL AND constructor_id IS NULL) OR (user_id IS NULL AND constructor_id IS NOT NULL)),
        UNIQUE (league_id, gameweek, user_id),
        UNIQUE (league_id, gameweek, constructor_id)
    );`,

    // 2. --- INDEXES ---

    // Index for fast user lookup
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);`,

    // 3. --- TRIGGER FUNCTION (PL/pgSQL) ---

    // Custom function to log changes to the users table
    `CREATE OR REPLACE FUNCTION log_user_changes()
    RETURNS TRIGGER AS $$
    DECLARE
        v_old_data JSONB;
        v_new_data JSONB;
    BEGIN
        IF TG_OP = 'INSERT' THEN
            -- Exclude sensitive/audit fields from the history log
            v_new_data := row_to_json(NEW)::jsonb - 'password_hash' - 'created_at' - 'verification_token';

            INSERT INTO users_history (user_id, action_type, new_data)
            VALUES (NEW.id, 'INSERT', v_new_data);

            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            -- Convert OLD and NEW records to JSONB, excluding the sensitive password_hash and verification_token
            v_old_data := row_to_json(OLD)::jsonb - 'password_hash' - 'created_at' - 'verification_token';
            v_new_data := row_to_json(NEW)::jsonb - 'password_hash' - 'created_at' - 'verification_token';

            -- Check if anything OTHER THAN the excluded columns changed
            IF v_old_data IS DISTINCT FROM v_new_data THEN
                INSERT INTO users_history (user_id, action_type, old_data, new_data)
                VALUES (NEW.id, 'UPDATE', v_old_data, v_new_data);
            END IF;

            RETURN NEW;

        END IF;
        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;`,

    // 4. --- TRIGGER ATTACHMENT ---

    // Attach the trigger function to the users table
    `CREATE OR REPLACE TRIGGER users_audit_trigger
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION log_user_changes();`,

    // Optional: DROP TABLE for clean restarts (useful during development)
    // Note: This line is commented out as per your original request, but included for completeness.
    // `DROP TABLE IF EXISTS F1_STANDINGS, F1_GW_STATS, F1_CHIP_USAGE, F1_DRIVER_ASSIGNMENTS, F1_CONSTRUCTORS, F1_LEAGUE, users_history, users CASCADE;`
];

module.exports.SQL_SCHEMA = SQL_SCHEMA;