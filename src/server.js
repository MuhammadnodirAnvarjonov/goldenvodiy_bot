// Golden Vodiy klinikasi Telegram boti - mustaqil servis.
// Ikkita vazifa:
//   1. Telegram bot (long-polling): bemor ro'yxati, onlayn navbat olish
//   2. Payme Merchant API endpointi: POST /payme (goldenvodiyclinic.uz orqali)
//
// Klinika dasturi (backend) lokal tarmoqda ishlashda davom etadi -
// bu servis faqat internetga qaraydigan qismlarni bajaradi.
const express = require('express');
const { Bot } = require('grammy');
const config = require('./config');
const db = require('./db');
const botController = require('./bot/bot.controller');
const PaymeController = require('./payme/payme.controller');

const start = async () => {
    // 1. Baza bilan aloqa
    try {
        await db.authenticate();
        console.log('✅ Baza bilan aloqa o\'rnatildi');
    } catch (e) {
        console.error('❌ Baza bilan aloqa yo\'q:', e.message);
        console.error('DB_HOST/DB_PORT sozlamalarini va klinika tunelini tekshiring.');
        // Bazasiz ishlashning ma'nosi yo'q - pm2 qayta urinadi
        process.exit(1);
    }

    // 2. Telegram bot
    if (!config.bot_token || config.bot_token.trim() === '') {
        console.error('❌ BOT_TOKEN topilmadi (.env). Bot ishga tushmaydi.');
        process.exit(1);
    }
    const bot = new Bot(config.bot_token);
    bot.catch((err) => {
        console.error('🤖 Bot xatosi:', err.message);
    });
    botController.botMessage(bot);
    botController.newSendMessage.connect(bot);
    bot.api.deleteWebhook().catch(() => {});
    bot.start({
        onStart: () => console.log('🤖 Bot ishga tushdi (long-polling)')
    });

    // 3. Payme Merchant API endpointi
    const app = express();
    app.use(express.json());

    // Payme shu manzilga POST yuboradi (kassada endpoint: https://goldenvodiyclinic.uz/payme)
    app.post('/payme', PaymeController.handle);

    // Monitoring uchun
    app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

    app.listen(config.port, () => {
        console.log(`💳 Payme endpoint: http://127.0.0.1:${config.port}/payme`);
    });
};

start();
