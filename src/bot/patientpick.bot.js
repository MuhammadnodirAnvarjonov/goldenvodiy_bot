// Bitta telefon raqamiga bir nechta bemor (oila a'zolari) ro'yxatdan o'tgan bo'lsa —
// foydalanuvchi o'zini tanlaydi. Tanlangan bemor chatga bog'lanadi; navbat, to'lov
// va natijalar shu bemor nomidan ishlaydi. Keyin /start orqali almashtirish mumkin.
//
// XAVFSIZLIK: ro'yxat faqat raqami tasdiqlangan foydalanuvchiga ko'rsatiladi
// (o'z kontaktini yuborgan yoki shu raqamdagi bemorga allaqachon bog'langan).
// Ruxsat etilgan bemor IDlari xotirada saqlanadi — qo'lda yasalgan "pp:<id>"
// callback bilan begona bemorni tanlab bo'lmaydi.
const { InlineKeyboard } = require('grammy');
const patient = require('../services/patient.service');
const { startRegistration, cancelRegistration } = require('./register.bot');

const PICK_TTL_MS = 30 * 60 * 1000;
// chat_id -> { at, phone, ids: Set<patientId> }
const picks = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [chatId, s] of picks) {
        if (now - s.at > PICK_TTL_MS) picks.delete(chatId);
    }
}, 5 * 60 * 1000).unref();

const pad = (n) => String(n).padStart(2, '0');
const fmtBirthday = (b) => {
    const s = String(b || '').trim();
    if (/^-?\d+$/.test(s)) {
        const d = new Date(Number(s) * 1000);
        if (!isNaN(d)) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    }
    return s.slice(0, 10);
};

const label = (p) => {
    const b = fmtBirthday(p.birthday);
    return `👤 ${patient.displayName(p)}${b ? ' · ' + b : ''}`;
};

// Raqam bo'yicha bemorlar ro'yxatini ko'rsatadi. currentId — hozir bog'langan bemor
// (almashtirishda belgilanadi)
const showPicker = async (ctx, phone, list, currentId = null) => {
    picks.set(ctx.chat.id, { at: Date.now(), phone, ids: new Set(list.map(p => Number(p.id))) });
    const kb = new InlineKeyboard();
    for (const p of list) {
        kb.text((Number(p.id) === Number(currentId) ? '✅ ' : '') + label(p), `pp:${p.id}`).row();
    }
    kb.text('➕ Men ro\'yxatda yo\'qman (yangi bemor)', 'pp:new').row();
    return ctx.reply(
        '📱 Bu raqamga bir nechta bemor ro\'yxatdan o\'tgan.\n\n' +
        'Siz qaysi birisiz? Navbat va natijalar tanlangan bemor nomidan bo\'ladi 👇',
        { reply_markup: kb }
    );
};

// Kontakt (tasdiqlangan raqam) kelganda: 0 ta -> ro'yxatdan o'tish,
// 1 ta -> darhol bog'lash, bir nechta -> tanlash
const handleVerifiedPhone = async (ctx, phone, mainMenu) => {
    const list = await patient.findAllByPhone(phone);
    if (!list.length) {
        await startRegistration(ctx, phone);
        return;
    }
    cancelRegistration(ctx.chat.id);
    if (list.length === 1) {
        await patient.linkChat(list[0].id, ctx.chat.id);
        await ctx.reply(
            `✅ ${patient.displayName(list[0])}, dasturdan muvaffaqiyatli ro'yxatdan o'tdingiz. Endi onlayn navbat olishingiz mumkin 👇`,
            { reply_markup: mainMenu }
        );
        return;
    }
    await showPicker(ctx, phone, list);
};

// /start da: bog'langan bemorning raqamida bir nechta bemor bo'lsa — darhol tanlash
// ro'yxati (hozirgisi ✅ bilan). Bitta bo'lsa — salomlashish va menyu.
const greetOrPick = async (ctx, current, mainMenu) => {
    const list = await patient.findAllByPhone(current.phone);
    if (list.length > 1) {
        return showPicker(ctx, patient.normalizePhone(current.phone), list, current.id);
    }
    return ctx.reply(`Assalomu alaykum, ${patient.displayName(current)}! Quyidagi menyudan foydalaning 👇`, {
        reply_markup: mainMenu
    });
};

function registerPatientPick(bot, mainMenu) {
    // Bog'langan bemor raqamidagi boshqa bemorlarni ko'rsatish
    bot.callbackQuery('pp:switch', async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const current = await patient.getOneByChatId(ctx.chat.id);
        if (!current) {
            return ctx.reply('Iltimos avval /start bosing va telefon raqamingizni yuboring.');
        }
        const list = await patient.findAllByPhone(current.phone);
        if (list.length < 2) {
            return ctx.editMessageText('Bu raqamda boshqa bemor yo\'q.').catch(() => {});
        }
        await ctx.deleteMessage().catch(() => {});
        await showPicker(ctx, patient.normalizePhone(current.phone), list, current.id);
    });

    // Yangi bemor (oila a'zosi ro'yxatda yo'q)
    bot.callbackQuery('pp:new', async (ctx) => {
        const s = picks.get(ctx.chat.id);
        if (!s) {
            return ctx.answerCallbackQuery({ text: 'Vaqt o\'tib ketdi. Qaytadan: /start', show_alert: true });
        }
        picks.delete(ctx.chat.id);
        await ctx.answerCallbackQuery().catch(() => {});
        await ctx.editMessageReplyMarkup().catch(() => {});
        await startRegistration(ctx, s.phone, { forceNew: true });
    });

    // Bemorni tanlash
    bot.callbackQuery(/^pp:(\d+)$/, async (ctx) => {
        const id = Number(ctx.match[1]);
        const s = picks.get(ctx.chat.id);
        if (!s || !s.ids.has(id)) {
            return ctx.answerCallbackQuery({ text: 'Vaqt o\'tib ketdi. Qaytadan: /start', show_alert: true });
        }
        // Tanlov paytida ham bemor shu raqamda ekanini qayta tekshiramiz
        const list = await patient.findAllByPhone(s.phone);
        const chosen = list.find(p => Number(p.id) === id);
        if (!chosen) {
            picks.delete(ctx.chat.id);
            return ctx.answerCallbackQuery({ text: 'Bemor topilmadi. Qaytadan: /start', show_alert: true });
        }
        picks.delete(ctx.chat.id);
        cancelRegistration(ctx.chat.id);
        await patient.linkChat(chosen.id, ctx.chat.id);
        await ctx.answerCallbackQuery({ text: '✅ Tanlandi' }).catch(() => {});
        await ctx.editMessageText(`✅ Siz ${patient.displayName(chosen)} sifatida tanlandingiz.`).catch(() => {});
        await ctx.reply('Endi onlayn navbat olishingiz mumkin 👇', { reply_markup: mainMenu });
    });
}

module.exports = {
    registerPatientPick,
    handleVerifiedPhone,
    greetOrPick,
};
