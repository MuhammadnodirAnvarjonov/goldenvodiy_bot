// Botdan foydalanish bo'yicha video qo'llanma.
// "🎬 Qo'llanma" tugmasi, /qollanma va /help buyruqlari videoni yuboradi.
// Video Telegram'ga bir marta yuklanadi, keyin uning file_id si ishlatiladi.
const path = require('path');
const fs = require('fs');
const { InputFile } = require('grammy');

const BTN_GUIDE = '🎬 Qo\'llanma';
const VIDEO_PATH = path.join(__dirname, '..', '..', 'assets', 'qollanma.mp4');

const CAPTION =
    '🎬 Botdan foydalanish bo\'yicha video qo\'llanma\n\n' +
    '1️⃣ /start bosing va telefon raqamingizni yuboring\n' +
    '2️⃣ Klinika bazasida bo\'lmasangiz — F.I.O va tug\'ilgan kuningizni kiritib ro\'yxatdan o\'ting\n' +
    '3️⃣ "📝 Navbat olish" → hizmat, kun va vaqtni tanlang\n' +
    '4️⃣ Bron to\'lovini to\'lang — navbatingiz tasdiqlanadi\n\n' +
    '"📋 Mening navbatlarim" bo\'limida navbatlaringizni ko\'rishingiz mumkin.';

let cachedFileId = null;

const sendGuide = async (ctx) => {
    try {
        if (!cachedFileId && !fs.existsSync(VIDEO_PATH)) {
            return ctx.reply('Qo\'llanma hozircha mavjud emas.');
        }
        await ctx.replyWithChatAction('upload_video').catch(() => {});
        const msg = await ctx.replyWithVideo(
            cachedFileId || new InputFile(VIDEO_PATH, 'qollanma.mp4'),
            {
                caption: CAPTION,
                supports_streaming: true,
                width: 720,
                height: 1562,
                duration: 47
            }
        );
        if (!cachedFileId && msg && msg.video) cachedFileId = msg.video.file_id;
    } catch (e) {
        console.error('Qo\'llanma yuborish xato:', e.message);
        // Saqlangan file_id eskirgan bo'lishi mumkin — keyingi safar qayta yuklanadi
        cachedFileId = null;
        await ctx.reply('Qo\'llanmani yuborishda xatolik. Birozdan so\'ng qayta urinib ko\'ring.').catch(() => {});
    }
};

// Ro'yxatdan o'tish va boshqa handlerlardan OLDIN ulanadi —
// tugma jarayonning istalgan bosqichida ishlashi uchun
function registerGuide(bot) {
    bot.command(['qollanma', 'help'], sendGuide);
    bot.hears(BTN_GUIDE, sendGuide);

    // Telegram'dagi "Menyu" tugmasida ko'rinadigan buyruqlar
    bot.api.setMyCommands([
        { command: 'start', description: 'Botni ishga tushirish' },
        { command: 'qollanma', description: 'Video qo\'llanma' }
    ]).catch((e) => console.error('setMyCommands xato:', e.message));
}

module.exports = {
    BTN_GUIDE,
    registerGuide,
};
