const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('<h1>Сервер работает через api/index.js!</h1>');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Экспортируем для Vercel
module.exports = app;