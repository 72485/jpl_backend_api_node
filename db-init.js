// db-init.js - Initialize database schema (run once on first deployment)

const db = require('./db');
const { SQL_SCHEMA } = require('./db');

const initDatabase = async () => {
    try {
        console.log('Initializing database schema...');

        for (const schema of SQL_SCHEMA) {
            try {
                await db.query(schema);
                console.log('✓ Schema created successfully');
            } catch (error) {
                // Some schemas may already exist, that's fine
                if (!error.message.includes('already exists')) {
                    console.error('Schema error:', error.message);
                }
            }
        }

        console.log('✓ Database initialization complete!');
        process.exit(0);
    } catch (error) {
        console.error('✗ Database initialization failed:', error);
        process.exit(1);
    }
};

initDatabase();
