const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase, pool } = require('./database');
const { Centrifuge } = require('centrifuge');

// ============================================================
// НАСТРОЙКИ DONATIONALERTS
// ============================================================
const DONATION_ALERTS_API_KEY = 'v2RTn937Q9oqfQk19temgZQhFPW8aeEn81LgdrLq';
// ============================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let db;
initializeDatabase().then(database => {
    db = database;
    console.log('✅ База данных готова');
    connectToDonationAlerts();
}).catch(err => {
    console.error('❌ Ошибка БД:', err);
    process.exit(1);
});

// ============================================================
// ПОДКЛЮЧЕНИЕ К DONATION ALERTS (WebSocket)
// ============================================================
async function connectToDonationAlerts() {
    console.log('🔌 Подключаюсь к DonationAlerts WebSocket...');
    
    const centrifuge = new Centrifuge('wss://centrifugo.donationalerts.com/connection/websocket', {
        debug: true,
        onPrivateSubscribe: async (data) => {
            const response = await fetch('https://www.donationalerts.com/api/v1/centrifuge/subscribe', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${DONATION_ALERTS_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data)
            });
            const result = await response.json();
            return result;
        }
    });

    centrifuge.on('connect', () => {
        console.log('🟢 Подключено к DonationAlerts WebSocket. Ожидание донатов...');
    });

    centrifuge.on('disconnect', () => {
        console.log('🔴 Соединение потеряно. Переподключение через 5 сек...');
        setTimeout(connectToDonationAlerts, 5000);
    });

    centrifuge.on('error', (err) => {
        console.error('❌ Ошибка соединения:', err);
    });

    const sub = centrifuge.newSubscription('$alerts:donation');
    
    sub.on('publication', async (ctx) => {
        console.log('💰 [НОВЫЙ ДОНАТ] Получены данные:', JSON.stringify(ctx.data, null, 2));
        await processDonation(ctx.data);
    });

    sub.on('subscribed', () => {
        console.log('✅ Успешная подписка на канал донатов!');
    });

    sub.on('error', (err) => {
        console.error('❌ Ошибка подписки на канал:', err);
    });

    sub.subscribe();
    centrifuge.connect();
}

// ============================================================
// ОБРАБОТКА ДОНАТА (PostgreSQL)
// ============================================================
async function processDonation(alertData) {
    try {
        const username = alertData.username;
        const amount = parseFloat(alertData.amount);
        const message = alertData.message;

        console.log(`📦 Обработка доната: ${username} -> $${amount}. Сообщение: "${message}"`);

        let country_code = null;
        if (message) {
            const match = message.match(/страны?\s+(\w+)/i);
            if (match) {
                country_code = match[1].toUpperCase();
            }
        }

        if (!country_code) {
            console.warn('⚠️ Не удалось извлечь код страны из сообщения.');
            return;
        }

        // Находим или создаем пользователя
        let userResult = await pool.query('SELECT id FROM users WHERE name = $1', [username]);
        let userId;
        
        if (userResult.rows.length === 0) {
            const newUser = await pool.query(
                'INSERT INTO users (name, country_code, country_name, total_donated) VALUES ($1, $2, $3, 0) RETURNING id',
                [username, country_code, country_code]
            );
            userId = newUser.rows[0].id;
            console.log(`👤 Создан новый пользователь: ${username}`);
        } else {
            userId = userResult.rows[0].id;
        }

        // Добавляем донат
        await pool.query(
            'INSERT INTO donations (user_id, country_code, amount) VALUES ($1, $2, $3)',
            [userId, country_code, amount]
        );

        // Обновляем total_donated
        await pool.query(
            'UPDATE users SET total_donated = total_donated + $1 WHERE id = $2',
            [amount, userId]
        );

        console.log(`✅ Донат зачислен: +$${amount} для ${username} в страну ${country_code}`);

        await checkAndUpdateRuler(country_code, username, userId, amount);

    } catch (error) {
        console.error('💥 Ошибка обработки доната:', error);
    }
}

async function checkAndUpdateRuler(country_code, username, user_id, amount) {
    const oldRuler = await pool.query(
        'SELECT ruler_id, ruler_name, amount FROM country_rulers WHERE country_code = $1',
        [country_code]
    );
    
    const newTotal = await pool.query(
        'SELECT SUM(amount) as total FROM donations WHERE user_id = $1 AND country_code = $2',
        [user_id, country_code]
    );
    
    const totalAmount = parseFloat(newTotal.rows[0].total) || 0;

    if (oldRuler.rows.length === 0) {
        await pool.query(
            `INSERT INTO country_rulers (country_code, ruler_name, ruler_id, amount, since_date)
             VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
            [country_code, username, user_id, totalAmount]
        );
        console.log(`👑 ${username} стал ПЕРВЫМ правителем ${country_code}!`);
    } else if (oldRuler.rows[0].ruler_id !== user_id && totalAmount > oldRuler.rows[0].amount) {
        await pool.query(
            `UPDATE country_rulers 
             SET ruler_name = $1, ruler_id = $2, amount = $3, since_date = CURRENT_DATE
             WHERE country_code = $4`,
            [username, user_id, totalAmount, country_code]
        );
        await pool.query(
            `INSERT INTO conquest_history (country_code, old_ruler_id, new_ruler_id, new_ruler_name, amount)
             VALUES ($1, $2, $3, $4, $5)`,
            [country_code, oldRuler.rows[0].ruler_id, user_id, username, totalAmount]
        );
        console.log(`⚔️ ${username} ЗАХВАТИЛ ${country_code}, свергнув ${oldRuler.rows[0].ruler_name}!`);
    } else if (oldRuler.rows[0].ruler_id === user_id) {
        await pool.query(
            'UPDATE country_rulers SET amount = $1 WHERE country_code = $2',
            [totalAmount, country_code]
        );
        console.log(`🛡️ ${username} укрепил свою власть в ${country_code}`);
    }
}

// ============================================================
// API ЭНДПОИНТЫ (PostgreSQL)
// ============================================================
app.get('/api/donors/:country', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.name, SUM(d.amount) as total
            FROM users u
            JOIN donations d ON u.id = d.user_id
            WHERE d.country_code = $1
            GROUP BY u.id, u.name
            ORDER BY total DESC
            LIMIT 10
        `, [req.params.country]);
        res.json({ donors: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/rankings/countries', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT country_code, SUM(amount) as total
            FROM donations
            GROUP BY country_code
            ORDER BY total DESC
            LIMIT 20
        `);
        res.json({ rankings: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/rankings/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT name, country_code, total_donated as total
            FROM users
            WHERE total_donated > 0
            ORDER BY total DESC
            LIMIT 20
        `);
        res.json({ users: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/country/:countryCode/ruler', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ruler_name, amount, 
                   EXTRACT(DAY FROM (CURRENT_DATE - since_date)) as days_held
            FROM country_rulers 
            WHERE country_code = $1
        `, [req.params.countryCode]);
        
        if (result.rows.length > 0) {
            const r = result.rows[0];
            res.json({ ruler: r.ruler_name, amount: r.amount, days_held: parseInt(r.days_held) || 1 });
        } else {
            res.json({ ruler: null });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/rulers/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT country_code, ruler_name, amount,
                   EXTRACT(DAY FROM (CURRENT_DATE - since_date)) as days_held
            FROM country_rulers
        `);
        res.json({ rulers: result.rows });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/conquests/recent', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT country_code, new_ruler_name, amount, captured_at
            FROM conquest_history
            ORDER BY captured_at DESC
            LIMIT 10
        `);
        res.json({ conquests: result.rows });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🌍 Сервер запущен на порту ${PORT}`);
});