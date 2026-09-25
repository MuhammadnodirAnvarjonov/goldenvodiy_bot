// Golden Vodiy klinikasi Telegram boti - mustaqil servis.
// Vazifalari:
//   1. Telegram bot (long-polling): bemor ro'yxati, onlayn navbat olish
//   2. Payme Merchant API:  POST /api/payme  (https://payments.goldenvodiyclinic.uz/api/payme)
//   3. Click SHOP API:      POST /api/click  (https://payments.goldenvodiyclinic.uz/api/click)
//
// Server joylashuvi: /srv/golden-vodiy-payments/current (127.0.0.1:3100),
// systemd: golden-vodiy-payments.service
// Klinika dasturi (backend) lokal tarmoqda ishlashda davom etadi -
// bu servis faqat internetga qaraydigan qismlarni bajaradi.
const express = require('express');
const { Bot } = require('grammy');
const config = require('./config');
const db = require('./db');
const botController = require('./bot/bot.controller');
const PaymeController = require('./payme/payme.controller');
const ClickController = require('./click/click.controller');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Baza holati - to'lov endpointlari bazasiz xato JSON qaytaradi, servis yiqilmaydi
let dbReady = false;

const start = async () => {
    // 1. HTTP darhol ko'tariladi (systemd/nginx uchun servis doim tirik turadi)
    const app = express();
    app.use(express.json());
    // Click ma'lumotni x-www-form-urlencoded ko'rinishda yuboradi
    app.use(express.urlencoded({ extended: true }));

    // Payme: https://payments.goldenvodiyclinic.uz/api/payme
    app.post('/api/payme', PaymeController.handle);
    // Click: https://payments.goldenvodiyclinic.uz/api/click
    app.post('/api/click', ClickController.handle);

    // Monitoring uchun
    const health = (req, res) => res.json({ ok: true, db: dbReady, time: Date.now() });
    app.get('/health', health);
    app.get('/api/health', health);

    // Eski yo'l (zaxira)
    app.post('/payme', PaymeController.handle);

    const host = process.env.HOST || '127.0.0.1';
    app.listen(config.port, host, () => {
        console.log(`💳 To'lov endpointlari: http://${host}:${config.port}/api/payme , /api/click`);
    });

    // 2. Baza bilan aloqa - klinika tuneli uzilgan bo'lsa qayta urinib turadi
    while (!dbReady) {
        try {
            await db.authenticate();
            dbReady = true;
            console.log('✅ Baza bilan aloqa o\'rnatildi');
        } catch (e) {
            console.error('⏳ Baza bilan aloqa yo\'q (15s dan keyin qayta urinadi):', e.message);
            await sleep(15000);
        }
    }

    // 3. Telegram bot (token kiritilgan bo'lsa)
    if (!config.bot_token || config.bot_token.trim() === '') {
        console.error('⚠️ BOT_TOKEN kiritilmagan (.env) — bot ishga tushmadi, faqat to\'lov endpointlari ishlaydi.');
        return;
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
};

start();
