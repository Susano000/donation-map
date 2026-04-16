const { Pool } = require('pg');

// Настройки подключения к Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Обязательно для Supabase
    }
});

async function initializeDatabase() {
    console.log('🔌 Подключение к PostgreSQL (Supabase)...');
    
    try {
        // Проверяем подключение
        await pool.query('SELECT NOW()');
        console.log('✅ Подключение к базе данных успешно!');
        
        // Создаём таблицы, если их нет
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                country_code TEXT NOT NULL,
                country_name TEXT NOT NULL,
                total_donated REAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS donations (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                country_code TEXT NOT NULL,
                amount REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS country_rulers (
                country_code TEXT PRIMARY KEY,
                ruler_name TEXT NOT NULL,
                ruler_id INTEGER NOT NULL REFERENCES users(id),
                amount REAL NOT NULL,
                since_date DATE NOT NULL DEFAULT CURRENT_DATE
            );
            
            CREATE TABLE IF NOT EXISTS conquest_history (
                id SERIAL PRIMARY KEY,
                country_code TEXT NOT NULL,
                old_ruler_id INTEGER,
                new_ruler_id INTEGER NOT NULL REFERENCES users(id),
                new_ruler_name TEXT NOT NULL,
                amount REAL NOT NULL,
                captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        console.log('✅ Таблицы созданы/проверены');
        
        // Проверяем, есть ли пользователи
        const count = await pool.query('SELECT COUNT(*) as c FROM users');
        if (parseInt(count.rows[0].c) === 0) {
            console.log('📦 База данных пуста. Ожидание реальных донатов...');
        } else {
            console.log(`✅ В базе уже ${count.rows[0].c} пользователей`);
        }
        
        return pool;
    } catch (err) {
        console.error('❌ Ошибка подключения к базе данных:', err);
        throw err;
    }
}

module.exports = { initializeDatabase, pool };