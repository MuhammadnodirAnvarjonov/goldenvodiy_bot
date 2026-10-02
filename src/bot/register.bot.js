// Bot orqali bemorning o'zini ro'yxatdan o'tkazishi.
// Telefon raqam (kontakt) bazada topilmasa bemordan ketma-ket so'raladi:
//   1) F.I.O  2) tug'ilgan kun (KK.OO.YYYY)  3) jinsi  4) tasdiqlash
// Tasdiqlangach bazada bemor yaratiladi (desktop formatida) va chat_id bog'lanadi.
// Holat xotirada saqlanadi (chat_id -> qadam va kiritilgan ma'lumotlar).
const { InlineKeyboard, Keyboard } = require('grammy');
const patient = require('../services/patient.service');

// chat_id -> { step: 'fio'|'birthday'|'gender'|'confirm', phone, fullname, birthday, gender }
const sessions = new Map();

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (unixSec) => {
    const d = new Date(Number(unixSec) * 1000);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};

// 'KK.OO.YYYY' (yoki - / bilan) -> kun boshining unix soniyasi; noto'g'ri bo'lsa null
const parseBirthday = (text) => {
    const m = /^\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\s*$/.exec(text || '');
    if (!m) return null;
    const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
    const d = new Date(year, month - 1, day, 0, 0, 0, 0);
    // 31.02 kabi mavjud bo'lmagan sanalarni rad etamiz
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    const now = new Date();
    if (d > now || year < now.getFullYear() - 120) return null;
    return Math.floor(d.getTime() / 1000);
};

const genderKeyboard = new InlineKeyboard()
    .text('👨 Erkak', 'rg:g:Erkak')
    .text('👩 Ayol', 'rg:g:Ayol');

const confirmKeyboard = new InlineKeyboard()
    .text('✅ Tasdiqlash', 'rg:ok').row()
    .text('✏️ Qaytadan kiritish', 'rg:redo');

const summaryText = (s) =>
    `📋 Ma'lumotlaringizni tekshiring:\n\n` +
    `👤 F.I.O: ${s.fullname}\n` +
    `📱 Telefon: +998 ${s.phone}\n` +
    `🎂 Tug'ilgan kun: ${fmtDate(s.birthday)}\n` +
    `⚧ Jinsi: ${s.gender}\n\n` +
    `Hammasi to'g'rimi?`;

const askFio = (ctx) => ctx.reply(
    '📝 Siz hali klinika bazasida ro\'yxatdan o\'tmagansiz. Keling, ro\'yxatdan o\'tamiz.\n\n' +
    'Familiya, ism va sharifingizni kiriting:\n(masalan: Aliyev Vali Karimovich)',
    { reply_markup: { remove_keyboard: true } }
);

// Kontakt bazada topilmaganda chaqiriladi
const startRegistration = async (ctx, phone) => {
    sessions.set(ctx.chat.id, { step: 'fio', phone });
    await askFio(ctx);
};

const isRegistering = (chatId) => sessions.has(chatId);
const cancelRegistration = (chatId) => sessions.delete(chatId);

function registerSelfRegistration(bot, mainMenu) {
    // Matnli javoblar (F.I.O va tug'ilgan kun) - faqat ro'yxatdan o'tish jarayonida
    bot.on('message:text', async (ctx, next) => {
        const s = sessions.get(ctx.chat.id);
        if (!s) return next();
        const text = (ctx.message.text || '').trim();
        if (text.startsWith('/')) return next(); // buyruqlar (/start) o'z yo'liga

        try {
            if (s.step === 'fio') {
                const fio = text.replace(/\s+/g, ' ');
                if (fio.length < 5 || fio.split(' ').length < 2 || /\d/.test(fio)) {
                    return ctx.reply('❗️ Iltimos familiya va ismingizni to\'liq kiriting (kamida 2 so\'z, raqamlarsiz):');
                }
                s.fullname = fio.substring(0, 300);
                s.step = 'birthday';
                return ctx.reply('🎂 Tug\'ilgan kuningizni kiriting (KK.OO.YYYY):\n(masalan: 15.03.1990)');
            }
            if (s.step === 'birthday') {
                const b = parseBirthday(text);
                if (!b) {
                    return ctx.reply('❗️ Sana noto\'g\'ri. Iltimos KK.OO.YYYY ko\'rinishida kiriting (masalan: 15.03.1990):');
                }
                s.birthday = b;
                s.step = 'gender';
                return ctx.reply('⚧ Jinsingizni tanlang:', { reply_markup: genderKeyboard });
            }
            // gender/confirm bosqichida matn yozilsa - tugmadan foydalanishni eslatamiz
            if (s.step === 'gender') {
                return ctx.reply('Iltimos quyidagi tugmalardan birini bosing:', { reply_markup: genderKeyboard });
            }
            if (s.step === 'confirm') {
                return ctx.reply(summaryText(s), { reply_markup: confirmKeyboard });
            }
        } catch (e) {
            console.error('register text xato:', e.message);
        }
    });

    // Jinsni tanlash
    bot.callbackQuery(/^rg:g:(Erkak|Ayol)$/, async (ctx) => {
        const s = sessions.get(ctx.chat.id);
        if (!s) return ctx.answerCallbackQuery({ text: 'Jarayon tugagan. Qaytadan: /start' });
        await ctx.answerCallbackQuery().catch(() => {});
        s.gender = ctx.match[1];
        s.step = 'confirm';
        await ctx.editMessageText(summaryText(s), { reply_markup: confirmKeyboard }).catch(() => {});
    });

    // Qaytadan kiritish
    bot.callbackQuery('rg:redo', async (ctx) => {
        const s = sessions.get(ctx.chat.id);
        if (!s) return ctx.answerCallbackQuery({ text: 'Jarayon tugagan. Qaytadan: /start' });
        await ctx.answerCallbackQuery().catch(() => {});
        sessions.set(ctx.chat.id, { step: 'fio', phone: s.phone });
        await ctx.editMessageText('✏️ Qaytadan kiritamiz.').catch(() => {});
        await askFio(ctx);
    });

    // Tasdiqlash -> bemorni yaratish
    bot.callbackQuery('rg:ok', async (ctx) => {
        const s = sessions.get(ctx.chat.id);
        if (!s || !s.fullname || !s.birthday || !s.gender) {
            return ctx.answerCallbackQuery({ text: 'Ma\'lumotlar to\'liq emas. Qaytadan: /start', show_alert: true });
        }
        try {
            await patient.createPatient({
                fullname: s.fullname,
                phone: s.phone,
                birthday: s.birthday,
                gender: s.gender,
                chat_id: ctx.chat.id
            });
            sessions.delete(ctx.chat.id);
            await ctx.answerCallbackQuery({ text: '✅ Ro\'yxatdan o\'tdingiz!' }).catch(() => {});
            await ctx.editMessageText(`✅ ${s.fullname}, siz muvaffaqiyatli ro'yxatdan o'tdingiz!`).catch(() => {});
            await ctx.reply('Endi onlayn navbat olishingiz mumkin 👇', { reply_markup: mainMenu });
        } catch (e) {
            console.error('register create xato:', e.message);
            await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.', show_alert: true }).catch(() => {});
        }
    });
}

module.exports = {
    registerSelfRegistration,
    startRegistration,
    isRegistering,
    cancelRegistration,
};
