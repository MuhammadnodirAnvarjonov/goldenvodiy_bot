const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    port: process.env.PORT || 3100,
    node_env: process.env.NODE_ENV,

    db_host: process.env.DB_HOST || '127.0.0.1',
    db_port: process.env.DB_PORT || 3306,
    db_user: process.env.DB_USER,
    db_pass: process.env.DB_PASS,
    db_name: process.env.DB_DATABASE,

    bot_token: process.env.BOT_TOKEN,

    // Onlayn navbat slotlari sozlamalari
    bot_queue_start: process.env.BOT_QUEUE_START || '09:00',
    bot_queue_end: process.env.BOT_QUEUE_END || '17:00',
    bot_queue_interval: process.env.BOT_QUEUE_INTERVAL_MIN || 30,
    // Botdan navbat bron qilingach to'lov uchun beriladigan vaqt (daqiqa)
    bot_pay_timeout: process.env.BOT_PAY_TIMEOUT_MIN || 15,

    // Telegram Payments provider token (BotFather -> Payments -> Payme) - zaxira usul
    payme_provider_token: process.env.PAYME_PROVIDER_TOKEN || '',
    // Payme Merchant API (kassa)
    payme_merchant_id: process.env.PAYME_MERCHANT_ID || '',
    payme_checkout_url: process.env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz',
    payme_key: process.env.PAYME_KEY || '',
    payme_test_key: process.env.PAYME_TEST_KEY || '',
    payme_mxik_code: process.env.PAYME_MXIK_CODE || '',
    payme_package_code: process.env.PAYME_PACKAGE_CODE || '',
    payme_vat_percent: process.env.PAYME_VAT_PERCENT || 0,

    // Click SHOP API (merchant kabinetidan olinadi)
    click_service_id: process.env.CLICK_SERVICE_ID || '',
    click_merchant_id: process.env.CLICK_MERCHANT_ID || '',
    click_secret_key: process.env.CLICK_SECRET_KEY || '',
};
