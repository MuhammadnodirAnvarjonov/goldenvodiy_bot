// Telegram bot orqali onlayn navbat olish.
// Bemor tekshiruvni (hizmatni) tanlaydi, kun tanlaydi va bo'sh vaqt oralig'iga yoziladi.
// Botda faqat dasturda (Tekshiruvlar sahifasida) ruxsat berilgan (bot_navbat = 1)
// tekshiruvlar ko'rinadi; navbat tekshiruvga biriktirilgan hodim (user_id) nomiga yoziladi.
// Slot sozlamalari .env dan: BOT_QUEUE_START, BOT_QUEUE_END, BOT_QUEUE_INTERVAL_MIN
const { InlineKeyboard, Keyboard } = require('grammy');
const { Op } = require('sequelize');
const sequelize = require('../db');
const UserModel = require('../models/user.model');
const QueueModel = require('../models/queue.model');
const DoctorModel = require('../models/doctor.model');
const inspectorCategoryModel = require('../models/inspector_category.model');
const inspectionModel = require('../models/inspection.model');
const PatientModel = require('../models/patient.model');
const PaymeTransactionModel = require('../models/payme_transaction.model');
const ClickTransactionModel = require('../models/click_transaction.model');
const patient = require('../services/patient.service');
const config = require('../config');

const BTN_NAVBAT = '📝 Navbat olish';
const BTN_MY = '📋 Mening navbatlarim';

// Bot orqali olingan navbat izohining boshi — hizmat nomi shu yerda saqlanadi
const BOT_COMMENT_PREFIX = 'Telegram bot: ';
// To'lov qilingan navbat izohiga qo'shiladigan belgi
const PAID_MARK = ' | ✅ To\'langan (Payme)';
// To'lov hali qilinmagan (bron) navbat belgisi — to'lov o'tgach olib tashlanadi
const PENDING_MARK = ' | ⏳ To\'lov kutilmoqda';

const mainMenu = new Keyboard()
    .text(BTN_NAVBAT).row()
    .text(BTN_MY)
    .resized();

const phoneKeyboard = new Keyboard()
    .requestContact('📱 Telefon raqamni yuborish')
    .row()
    .resized();

// 'HH:MM' -> kun boshidan sekund
const parseTime = (str, def) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
    if (!m) return def;
    return Number(m[1]) * 3600 + Number(m[2]) * 60;
};
const QUEUE_START = parseTime(config.bot_queue_start, 9 * 3600);        // ish boshlanishi
const QUEUE_END = parseTime(config.bot_queue_end, 17 * 3600);           // ish tugashi
const INTERVAL = (Number(config.bot_queue_interval) || 30) * 60;        // slot davomiyligi (sek)
const DAYS_AHEAD = 7; // necha kun oldindan navbat olish mumkin

const WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

const pad = (n) => String(n).padStart(2, '0');
// kun boshidan sekund -> 'HH:MM'
const fmtTime = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}`;
const fmtDate = (unixSec) => {
    const d = new Date(unixSec * 1000);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};
// Bugungi kun boshi (server lokal vaqti) + offset kun, unix sekund
const dayStartSec = (offsetDays = 0) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) + offsetDays * 86400;
};
const nowSec = () => Math.floor(Date.now() / 1000);

// 'queue_delete' qilinmagan (aktiv) navbatlar sharti
const notDeleted = { [Op.or]: [{ [Op.is]: null }, { [Op.ne]: 'queue_delete' }] };

// To'lov uchun beriladigan muddat (sekundlarda)
const PAY_TIMEOUT_SEC = (Number(config.bot_pay_timeout) || 15) * 60;

// To'lovi kutilayotgan va muddati o'tib ketgan bron (bot navbati)
const isExpiredPending = (r) => {
    const c = r.comment || '';
    return !r.reg_id && c.includes(PENDING_MARK) && !c.includes(PAID_MARK) &&
        r.bot_time && (Number(r.bot_time) + PAY_TIMEOUT_SEC) < nowSec();
};

// Qator slotni real band qiladimi (muddati o'tgan to'lovsiz bron band hisoblanmaydi)
const isActiveBusy = (r) => (r.type == 1 || r.patient_id) && !isExpiredPending(r);

// Bronni bo'shatish (deletedQueue bilan bir xil holat)
const releaseQueueRow = async (r, transaction = null) => {
    r.room_id = null;
    r.reg_id = null;
    r.patient_id = null;
    r.status = 'waiting';
    r.comment = '';
    r.type = false;
    r.deleted = 'queue_delete';
    await r.save(transaction ? { transaction } : {});
};

// Navbat bo'yicha aktiv (yaratilgan yoki to'langan) Payme/Click tranzaksiyasi bormi —
// bor bo'lsa bronni bo'shatib bo'lmaydi (pul yo'lda yoki olingan)
const hasActivePaymeTxn = async (queueId, transaction = null) => {
    const txn = await PaymeTransactionModel.findOne({
        where: { queue_id: queueId, state: { [Op.in]: [1, 2] } },
        ...(transaction ? { transaction } : {})
    });
    if (txn) return true;
    const clickTxn = await ClickTransactionModel.findOne({
        where: { queue_id: queueId, state: { [Op.in]: [1, 2] } },
        ...(transaction ? { transaction } : {})
    });
    return !!clickTxn;
};

// Muddati o'tgan to'lovsiz bronlarni davriy ravishda bo'shatib turadi
let botRef = null;
const releaseExpiredReservations = async () => {
    try {
        const rows = await QueueModel.findAll({
            where: {
                reg_id: { [Op.is]: null },
                deleted: notDeleted,
                comment: { [Op.like]: `%${PENDING_MARK}%` },
                bot_time: { [Op.lt]: nowSec() - PAY_TIMEOUT_SEC }
            }
        });
        for (const r of rows) {
            if ((r.comment || '').includes(PAID_MARK)) continue;
            if (await hasActivePaymeTxn(r.id)) continue;
            const patientId = r.patient_id;
            const qTime = r.date_time;
            await releaseQueueRow(r);
            // Bemorga xabar beramiz
            if (botRef && patientId) {
                try {
                    const p = await PatientModel.findOne({
                        where: { id: patientId },
                        attributes: ['id', 'chat_id']
                    });
                    if (p && p.chat_id) {
                        const d = new Date(qTime * 1000);
                        const t = d.getHours() * 3600 + d.getMinutes() * 60;
                        await botRef.api.sendMessage(
                            p.chat_id,
                            `⏳ To'lov qilinmagani uchun ${fmtDate(qTime)} ${fmtTime(t)} dagi navbatingiz bekor qilindi.\n` +
                            `Xohlasangiz qaytadan navbat olishingiz mumkin.`
                        );
                    }
                } catch (e) {
                    console.error('Bron bekor xabari xato:', e.message);
                }
            }
        }
    } catch (e) {
        console.error('releaseExpiredReservations xato:', e.message);
    }
};

// Botda ko'rinadigan hizmatlar: ruxsat berilgan va hodimga biriktirilgan tekshiruvlar
const getBotInspections = async () => {
    return await inspectionModel.findAll({
        where: {
            bot_navbat: 1,
            user_id: { [Op.ne]: null }
        },
        attributes: ['id', 'name', 'user_id', 'price'],
        order: [['index_num', 'ASC'], ['id', 'ASC']]
    });
};

const getInspection = async (id) => {
    return await inspectionModel.findOne({
        where: { id: id, bot_navbat: 1 },
        attributes: ['id', 'name', 'user_id', 'price']
    });
};

// Telegram Payments (Payme provayderi) yoqilganmi
const PAYME_TOKEN = (config.payme_provider_token || '').trim();

// Payme Merchant API (kassa) yoqilganmi — bo'lsa to'lov checkout link orqali qilinadi
const PAYME_MERCHANT_ID = (config.payme_merchant_id || '').trim();

// Payme checkout sahifasiga GET-redirect link (chek yaratish, GET usuli).
// Format: base64("m=<kassa>;ac.queue_id=<navbat>;a=<summa tiyinda>;l=uz")
const PAYME_CHECKOUT_URL = (config.payme_checkout_url || 'https://checkout.paycom.uz').replace(/\/+$/, '');
const buildCheckoutUrl = (queueId, amountTiyin) => {
    const payload = `m=${PAYME_MERCHANT_ID};ac.queue_id=${queueId};a=${amountTiyin};l=uz`;
    return PAYME_CHECKOUT_URL + '/' + Buffer.from(payload, 'utf8').toString('base64');
};

// Click yoqilganmi (merchant kabinetidan olingan qiymatlar to'liq bo'lsa)
const CLICK_ENABLED = !!(
    (config.click_service_id || '').trim() &&
    (config.click_merchant_id || '').trim() &&
    (config.click_secret_key || '').trim()
);

// Click to'lov sahifasi linki (transaction_param = queue_id, summa so'mda)
const buildClickUrl = (queueId, amountSum) => {
    return 'https://my.click.uz/services/pay' +
        `?service_id=${encodeURIComponent(String(config.click_service_id).trim())}` +
        `&merchant_id=${encodeURIComponent(String(config.click_merchant_id).trim())}` +
        `&amount=${amountSum}` +
        `&transaction_param=${queueId}`;
};

// To'lov usullari klaviaturasiga tugmalar qo'shadi (mavjud tizimlar bo'yicha)
const addPayButtons = (kb, queueId, priceSum, label) => {
    if (PAYME_MERCHANT_ID) {
        kb.url(`💳 ${label ? label + ' — ' : ''}Payme orqali to'lash`, buildCheckoutUrl(queueId, Math.round(priceSum * 100))).row();
    }
    if (CLICK_ENABLED) {
        kb.url(`💳 ${label ? label + ' — ' : ''}Click orqali to'lash`, buildClickUrl(queueId, priceSum)).row();
    }
};

// Hodim ko'rinadigan nomi (bot bookinglarida hizmat nomi comment da saqlanadi,
// bu label desktopdan olingan navbatlar uchun zaxira)
const userLabel = (u) => {
    if (!u) return '-';
    if (u.doctor) return u.doctor.name;
    if (u.inspecton && u.inspecton.name) return u.inspecton.name;
    return u.user_name;
};

// Hizmat (tekshiruv) tanlash klaviaturasi
const buildServicesKeyboard = async () => {
    const inspections = await getBotInspections();
    if (!inspections.length) return null;
    const kb = new InlineKeyboard();
    for (const ins of inspections) {
        kb.text(ins.name, `qd:${ins.id}`).row();
    }
    return kb;
};

// Kun tanlash klaviaturasi (bugundan boshlab DAYS_AHEAD kun)
const buildDaysKeyboard = (insId) => {
    const kb = new InlineKeyboard();
    for (let i = 0; i < DAYS_AHEAD; i++) {
        const day = dayStartSec(i);
        // bugun ish vaqti tugagan bo'lsa, bugunni ko'rsatmaymiz
        if (i === 0 && day + QUEUE_END - INTERVAL <= nowSec()) continue;
        const d = new Date(day * 1000);
        let label = `${fmtDate(day)} (${WEEKDAYS[d.getDay()]})`;
        if (i === 0) label = `Bugun — ${label}`;
        if (i === 1) label = `Ertaga — ${label}`;
        kb.text(label, `qs:${insId}:${day}`).row();
    }
    kb.text('⬅️ Orqaga', 'qback').row();
    return kb;
};

// Bir kunlik slotlar klaviaturasi: bo'sh — 🟢 (bosiladi), band — 🔴 (bosilmaydi)
// Bandlik tekshiruvga biriktirilgan hodim (userId) navbatlari bo'yicha aniqlanadi
const buildSlotsKeyboard = async (insId, userId, day) => {
    const rows = await QueueModel.findAll({
        where: {
            user_id: userId,
            date_time: { [Op.gte]: day, [Op.lte]: day + 86399 },
            deleted: notDeleted
        },
        attributes: ['date_time', 'type', 'patient_id', 'comment', 'bot_time', 'reg_id'],
        raw: true
    });
    const kb = new InlineKeyboard();
    let count = 0, hasFree = false;
    for (let t = QUEUE_START; t + INTERVAL <= QUEUE_END; t += INTERVAL) {
        const slotAbs = day + t;
        if (slotAbs <= nowSec()) continue; // o'tib ketgan slotlar ko'rsatilmaydi
        // type = 0 va bemorsiz qator — oldindan ochilgan BO'SH joy;
        // muddati o'tgan to'lovsiz bron ham bo'sh hisoblanadi
        const busy = rows.some(r =>
            r.date_time >= slotAbs && r.date_time < slotAbs + INTERVAL &&
            isActiveBusy(r)
        );
        const range = `${fmtTime(t)} - ${fmtTime(t + INTERVAL)}`;
        if (busy) {
            kb.text(`🔴 ${range} · band`, 'qbusy');
        } else {
            kb.text(`🟢 ${range}`, `qb:${insId}:${slotAbs}`);
            hasFree = true;
        }
        if (++count % 2 === 0) kb.row();
    }
    if (count % 2 !== 0) kb.row();
    kb.text('⬅️ Orqaga', `qd:${insId}`).row();
    return { kb, count, hasFree };
};

// chat_id bo'yicha ro'yxatdan o'tgan bemorni topadi, bo'lmasa telefon so'raydi
const requirePatient = async (ctx) => {
    const model = await patient.getOneByChatId(ctx.chat.id);
    if (!model) {
        await ctx.reply('Iltimos avval telefon raqamni yuboring', {
            reply_markup: phoneKeyboard
        });
        return null;
    }
    return model;
};

function registerNavbat(bot) {
    // To'lov tizimi sozlanmagan bo'lsa — bot navbatlari TO'LOVSIZ beriladi
    if (!PAYME_MERCHANT_ID && !PAYME_TOKEN && !CLICK_ENABLED) {
        console.warn(
            "⚠️ To'lov tizimi sozlanmagan (.env da PAYME_MERCHANT_ID/CLICK_SERVICE_ID yo'q) — " +
            "bot navbatlari to'lovsiz tasdiqlanadi. To'lov majburiy bo'lishi uchun " +
            "kassa ma'lumotlarini .env ga kiriting."
        );
    }
    // Muddati o'tgan to'lovsiz bronlarni davriy bo'shatish (har 3 daqiqada)
    botRef = bot;
    setInterval(releaseExpiredReservations, 3 * 60 * 1000);
    releaseExpiredReservations();

    // 1-qadam: hizmat (tekshiruv) tanlash
    bot.hears(BTN_NAVBAT, async (ctx) => {
        try {
            const p = await requirePatient(ctx);
            if (!p) return;
            const kb = await buildServicesKeyboard();
            if (!kb) {
                return ctx.reply('Hozircha onlayn navbat olish uchun hizmatlar mavjud emas.');
            }
            await ctx.reply('👨‍⚕️ Qaysi hizmatga navbat olmoqchisiz?', { reply_markup: kb });
        } catch (e) {
            console.error('BTN_NAVBAT xato:', e.message);
        }
    });

    // Mening navbatlarim
    bot.hears(BTN_MY, async (ctx) => {
        try {
            const p = await requirePatient(ctx);
            if (!p) return;
            const list = await QueueModel.findAll({
                where: {
                    patient_id: p.id,
                    date_time: { [Op.gte]: dayStartSec(0) },
                    deleted: notDeleted
                },
                include: [{
                    model: UserModel,
                    as: 'user',
                    attributes: ['id', 'user_name'],
                    include: [
                        { model: DoctorModel, as: 'doctor', attributes: ['name'] },
                        { model: inspectorCategoryModel, as: 'inspecton', attributes: ['name'] }
                    ]
                }],
                order: [['date_time', 'ASC']]
            });
            if (!list.length) {
                return ctx.reply('Sizda faol navbat yo\'q.', { reply_markup: mainMenu });
            }
            // To'lanmagan navbatlar uchun narxlar (Payme/Click to'lov linklari uchun)
            let priceMap = {};
            if (PAYME_MERCHANT_ID || CLICK_ENABLED) {
                const insIds = [...new Set(list.map(q => q.ins_id).filter(Boolean))];
                if (insIds.length) {
                    const insList = await inspectionModel.findAll({
                        where: { id: insIds },
                        attributes: ['id', 'price'],
                        raw: true
                    });
                    insList.forEach(i => { priceMap[i.id] = Number(i.price) || 0; });
                }
            }
            let text = '📋 Sizning navbatlaringiz:\n';
            const kb = new InlineKeyboard();
            for (const q of list) {
                // Bot orqali olingan bo'lsa hizmat nomi comment da turadi
                const serviceName = q.comment && q.comment.startsWith(BOT_COMMENT_PREFIX)
                    ? q.comment.slice(BOT_COMMENT_PREFIX.length)
                    : userLabel(q.user);
                const qd = new Date(q.date_time * 1000);
                const t = qd.getHours() * 3600 + qd.getMinutes() * 60;
                text += `\n👨‍⚕️ ${serviceName}\n📅 ${fmtDate(q.date_time)}  🕐 ${fmtTime(t)}  (№ ${q.number})\n`;
                // Faqat bot orqali olingan (registratsiyasiz, to'lanmagan) kelajakdagi navbatni bekor qilish mumkin
                if (!q.reg_id && q.date_time > nowSec() && !(q.comment || '').includes(PAID_MARK)) {
                    // To'lanmagan bo'lsa — Payme/Click to'lov linklari ham chiqadi
                    if (q.ins_id && priceMap[q.ins_id] > 0) {
                        addPayButtons(kb, q.id, priceMap[q.ins_id], `${fmtDate(q.date_time)} ${fmtTime(t)}`);
                    }
                    kb.text(`❌ ${fmtDate(q.date_time)} ${fmtTime(t)} — bekor qilish`, `qc:${q.id}`).row();
                }
            }
            await ctx.reply(text, { reply_markup: kb.inline_keyboard.length ? kb : mainMenu });
        } catch (e) {
            console.error('BTN_MY xato:', e.message);
        }
    });

    // Orqaga: hizmatlar ro'yxatiga qaytish
    bot.callbackQuery('qback', async (ctx) => {
        try {
            await ctx.answerCallbackQuery();
            const kb = await buildServicesKeyboard();
            if (!kb) return;
            await ctx.editMessageText('👨‍⚕️ Qaysi hizmatga navbat olmoqchisiz?', { reply_markup: kb });
        } catch (e) {
            console.error('qback xato:', e.message);
        }
    });

    // 2-qadam: kun tanlash
    bot.callbackQuery(/^qd:(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCallbackQuery();
            const ins = await getInspection(Number(ctx.match[1]));
            if (!ins) {
                return ctx.editMessageText('Bu hizmat endi mavjud emas. Qaytadan tanlang: /start').catch(() => {});
            }
            await ctx.editMessageText(`🩺 ${ins.name}\n📅 Qaysi kunga navbat olmoqchisiz?`, {
                reply_markup: buildDaysKeyboard(ins.id)
            });
        } catch (e) {
            console.error('qd xato:', e.message);
        }
    });

    // 3-qadam: slotlarni ko'rsatish
    bot.callbackQuery(/^qs:(\d+):(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCallbackQuery();
            const ins = await getInspection(Number(ctx.match[1]));
            const day = Number(ctx.match[2]);
            if (!ins) {
                return ctx.editMessageText('Bu hizmat endi mavjud emas. Qaytadan tanlang: /start').catch(() => {});
            }
            const { kb, count, hasFree } = await buildSlotsKeyboard(ins.id, ins.user_id, day);
            let text = `🩺 ${ins.name}\n🕐 ${fmtDate(day)} kuni uchun vaqtni tanlang:\n🟢 — bo'sh, 🔴 — band`;
            if (!count) text = `${fmtDate(day)} kuni uchun qabul vaqti tugagan.`;
            else if (!hasFree) text = `🩺 ${ins.name}\n${fmtDate(day)} kuniga bo'sh navbat qolmagan. Boshqa kunni tanlang.`;
            await ctx.editMessageText(text, { reply_markup: kb });
        } catch (e) {
            console.error('qs xato:', e.message);
        }
    });

    // Band slot bosilganda
    bot.callbackQuery('qbusy', async (ctx) => {
        await ctx.answerCallbackQuery({ text: '⛔ Bu vaqt band. Boshqa vaqtni tanlang.' }).catch(() => {});
    });

    // 4-qadam: navbatga yozish
    bot.callbackQuery(/^qb:(\d+):(\d+)$/, async (ctx) => {
        const insId = Number(ctx.match[1]);
        const slotAbs = Number(ctx.match[2]);
        try {
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) {
                return ctx.answerCallbackQuery({ text: 'Avval ro\'yxatdan o\'ting.', show_alert: true });
            }
            const ins = await getInspection(insId);
            if (!ins) {
                return ctx.answerCallbackQuery({ text: 'Bu hizmat endi mavjud emas.', show_alert: true });
            }
            const userId = ins.user_id;
            if (slotAbs <= nowSec()) {
                return ctx.answerCallbackQuery({ text: '⛔ Bu vaqt o\'tib ketdi.', show_alert: true });
            }
            const sd = new Date(slotAbs * 1000);
            sd.setHours(0, 0, 0, 0);
            const day = Math.floor(sd.getTime() / 1000);
            const slotOfDay = slotAbs - day;

            // To'lov majburiy: kassa (Payme/Click yoki invoice) sozlangan va hizmat narxi bor bo'lsa
            const price = Number(ins.price) || 0;
            const payRequired = !!((PAYME_MERCHANT_ID || PAYME_TOKEN || CLICK_ENABLED) && price > 0);

            const transaction = await sequelize.transaction();
            let created = null;
            try {
                // Bir bemorga bir hodimga bir kunda bitta navbat
                const mine = await QueueModel.findOne({
                    where: {
                        user_id: userId,
                        patient_id: p.id,
                        date_time: { [Op.gte]: day, [Op.lte]: day + 86399 },
                        deleted: notDeleted
                    },
                    transaction
                });
                if (mine) {
                    const mComment = mine.comment || '';
                    if (isExpiredPending(mine) && !(await hasActivePaymeTxn(mine.id, transaction))) {
                        // O'zining muddati o'tgan to'lovsiz broni — bo'shatib davom etamiz
                        await releaseQueueRow(mine, transaction);
                    } else if (!mine.reg_id && mComment.includes(PENDING_MARK) && !mComment.includes(PAID_MARK)) {
                        await transaction.rollback();
                        const t = mine.date_time - day;
                        return ctx.answerCallbackQuery({
                            text: `Sizda ${fmtTime(t)} ga to'lov kutilayotgan navbat bor. "Mening navbatlarim" bo'limidan to'lang yoki bekor qiling.`,
                            show_alert: true
                        });
                    } else {
                        await transaction.rollback();
                        const t = mine.date_time - day;
                        return ctx.answerCallbackQuery({
                            text: `Sizda bu kunga allaqachon navbat bor: ${fmtTime(t)}`,
                            show_alert: true
                        });
                    }
                }
                // Slot hali bo'shligini qulf ostida tekshiramiz (parallel bron qarshi)
                const slotRows = await QueueModel.findAll({
                    where: {
                        user_id: userId,
                        date_time: { [Op.gte]: slotAbs, [Op.lt]: slotAbs + INTERVAL },
                        deleted: notDeleted
                    },
                    lock: transaction.LOCK.UPDATE,
                    transaction
                });
                // Band qatorni aniqlaymiz; muddati o'tgan to'lovsiz bronlar bo'shatiladi
                let busyRow = null;
                for (const r of slotRows) {
                    if (r.deleted === 'queue_delete') continue;
                    if (!(r.type == 1 || r.patient_id)) continue; // oldindan ochilgan bo'sh joy
                    if (isExpiredPending(r)) {
                        if (await hasActivePaymeTxn(r.id, transaction)) { busyRow = r; break; }
                        await releaseQueueRow(r, transaction);
                        continue;
                    }
                    busyRow = r;
                    break;
                }
                // Oldindan ochilgan bo'sh joy (type = 0) bo'lsa — yangi yaratmasdan uni band qilamiz
                const emptyRow = slotRows.find(r => r.deleted !== 'queue_delete' && !(r.type == 1 || r.patient_id));
                if (busyRow) {
                    await transaction.rollback();
                    await ctx.answerCallbackQuery({ text: '⛔ Bu vaqt hozirgina band qilindi.', show_alert: true }).catch(() => {});
                    // slotlar ro'yxatini yangilab qo'yamiz
                    const { kb } = await buildSlotsKeyboard(ins.id, userId, day);
                    await ctx.editMessageText(
                        `🩺 ${ins.name}\n🕐 ${fmtDate(day)} kuni uchun vaqtni tanlang:\n🟢 — bo'sh, 🔴 — band`,
                        { reply_markup: kb }
                    ).catch(() => {});
                    return;
                }
                const comment = (BOT_COMMENT_PREFIX + ins.name + (payRequired ? PENDING_MARK : '')).substring(0, 800);
                if (emptyRow) {
                    // Desktop yaratgan bo'sh joyni band qilamiz — raqami va vaqti saqlanadi
                    emptyRow.patient_id = p.id;
                    emptyRow.status = 'waiting';
                    emptyRow.type = 1;
                    emptyRow.comment = comment;
                    emptyRow.deleted = '';
                    emptyRow.show_tablo = true;
                    emptyRow.ins_id = ins.id;
                    emptyRow.bot_time = nowSec();
                    await emptyRow.save({ transaction });
                    created = emptyRow;
                } else {
                    // Navbat raqami frontend formulasi bilan: (vaqt - ish boshlanishi) / interval
                    let number = Math.round((slotOfDay - QUEUE_START) / INTERVAL);
                    if (number < 0) number = 0;
                    created = await QueueModel.create({
                        room_id: null,
                        patient_id: p.id,
                        number: number,
                        date_time: slotAbs,
                        status: 'waiting',
                        user_id: userId,
                        comment: comment,
                        type: 1,
                        reg_id: null,
                        deleted: '',
                        show_tablo: true,
                        ins_id: ins.id,
                        bot_time: nowSec()
                    }, { transaction });
                }
                await transaction.commit();
            } catch (err) {
                await transaction.rollback();
                throw err;
            }

            let confirmText;
            const opts = {};
            if (payRequired) {
                // Navbat faqat TO'LOVDAN KEYIN tasdiqlanadi
                await ctx.answerCallbackQuery({ text: '⏳ Joy band qilindi — to\'lovni yakunlang' }).catch(() => {});
                const timeoutMin = Math.round(PAY_TIMEOUT_SEC / 60);
                confirmText =
                    `⏳ Joy siz uchun vaqtincha band qilindi!\n\n` +
                    `🩺 Hizmat: ${ins.name}\n` +
                    `📅 Sana: ${fmtDate(slotAbs)}\n` +
                    `🕐 Vaqt: ${fmtTime(slotOfDay)} - ${fmtTime(slotOfDay + INTERVAL)}\n` +
                    `🔢 Navbat raqami: ${created.number}\n` +
                    `💰 To'lov: ${price.toLocaleString('ru-RU')} so'm\n\n` +
                    `❗️ Navbat to'lovdan keyin tasdiqlanadi. Iltimos ${timeoutMin} daqiqa ichida to'lovni amalga oshiring — ` +
                    `aks holda joy avtomatik bo'shatiladi.`;
                const kbPay = new InlineKeyboard();
                // Payme (checkout link) va Click tugmalari
                addPayButtons(kbPay, created.id, price);
                if (!PAYME_MERCHANT_ID && !CLICK_ENABLED && PAYME_TOKEN) {
                    // Zaxira: Telegram Payments hisob-fakturasi
                    kbPay.text('💳 Payme orqali to\'lash', `qp:${created.id}:${ins.id}`).row();
                }
                kbPay.text('❌ Bekor qilish', `qc:${created.id}`);
                opts.reply_markup = kbPay;
            } else {
                // To'lov talab qilinmaydi (kassa sozlanmagan yoki hizmat bepul)
                await ctx.answerCallbackQuery({ text: '✅ Navbat olindi!' }).catch(() => {});
                confirmText =
                    `✅ Navbatga muvaffaqiyatli yozildingiz!\n\n` +
                    `🩺 Hizmat: ${ins.name}\n` +
                    `📅 Sana: ${fmtDate(slotAbs)}\n` +
                    `🕐 Vaqt: ${fmtTime(slotOfDay)} - ${fmtTime(slotOfDay + INTERVAL)}\n` +
                    `🔢 Navbat raqami: ${created.number}\n\n` +
                    `Iltimos belgilangan vaqtdan 10 daqiqa oldin keling.`;
            }
            await ctx.editMessageText(confirmText, opts);
        } catch (e) {
            console.error('qb xato:', e.message);
            await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.', show_alert: true }).catch(() => {});
        }
    });

    // To'lov tugmasi bosilganda — Telegram Payments (Payme) hisob-fakturasi yuboriladi
    bot.callbackQuery(/^qp:(\d+):(\d+)$/, async (ctx) => {
        try {
            if (!PAYME_TOKEN) {
                return ctx.answerCallbackQuery({ text: 'Onlayn to\'lov hozircha yoqilmagan.', show_alert: true });
            }
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) return ctx.answerCallbackQuery();
            const q = await QueueModel.findOne({ where: { id: Number(ctx.match[1]) } });
            if (!q || q.patient_id != p.id || q.deleted === 'queue_delete') {
                return ctx.answerCallbackQuery({ text: 'Navbat topilmadi yoki bekor qilingan.', show_alert: true });
            }
            if (q.comment && q.comment.includes(PAID_MARK)) {
                return ctx.answerCallbackQuery({ text: '✅ Bu navbat allaqachon to\'langan.', show_alert: true });
            }
            const ins = await getInspection(Number(ctx.match[2]));
            const price = ins ? Number(ins.price) || 0 : 0;
            if (!ins || price <= 0) {
                return ctx.answerCallbackQuery({ text: 'Bu hizmat uchun onlayn to\'lov mavjud emas.', show_alert: true });
            }
            await ctx.answerCallbackQuery().catch(() => {});
            // Telegram: title <= 32, description <= 255 belgi; amount tiyinda (so'm * 100)
            await ctx.replyWithInvoice(
                ins.name.substring(0, 32),
                `${ins.name} — ${fmtDate(q.date_time)} kungi navbat (№ ${q.number}) uchun to'lov`.substring(0, 255),
                `pay:${q.id}:${ins.id}`,
                'UZS',
                [{ label: ins.name.substring(0, 32), amount: Math.round(price * 100) }],
                { provider_token: PAYME_TOKEN }
            );
        } catch (e) {
            console.error('qp xato:', e.message);
            await ctx.answerCallbackQuery({ text: 'To\'lovni ochishda xatolik. Qaytadan urinib ko\'ring.', show_alert: true }).catch(() => {});
        }
    });

    // To'lovdan oldingi tekshiruv (Telegram 10 sekund ichida javob kutadi)
    bot.on('pre_checkout_query', async (ctx) => {
        try {
            const m = /^pay:(\d+):(\d+)$/.exec(ctx.preCheckoutQuery.invoice_payload || '');
            if (!m) {
                return ctx.answerPreCheckoutQuery(false, 'To\'lov ma\'lumotlari noto\'g\'ri.');
            }
            const q = await QueueModel.findOne({ where: { id: Number(m[1]) } });
            if (!q || q.deleted === 'queue_delete') {
                return ctx.answerPreCheckoutQuery(false, 'Navbat topilmadi yoki bekor qilingan.');
            }
            if (q.comment && q.comment.includes(PAID_MARK)) {
                return ctx.answerPreCheckoutQuery(false, 'Bu navbat allaqachon to\'langan.');
            }
            await ctx.answerPreCheckoutQuery(true);
        } catch (e) {
            console.error('pre_checkout xato:', e.message);
            await ctx.answerPreCheckoutQuery(false, 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.').catch(() => {});
        }
    });

    // Muvaffaqiyatli to'lov — navbat izohiga belgi qo'yiladi
    bot.on('message:successful_payment', async (ctx) => {
        try {
            const sp = ctx.message.successful_payment;
            const m = /^pay:(\d+):(\d+)$/.exec(sp.invoice_payload || '');
            const summa = (sp.total_amount / 100).toLocaleString('ru-RU');
            if (m) {
                const q = await QueueModel.findOne({ where: { id: Number(m[1]) } });
                if (q && !(q.comment || '').includes(PAID_MARK)) {
                    // "To'lov kutilmoqda" belgisi olinadi, "To'langan" qo'yiladi
                    const cleaned = (q.comment || '').split(PENDING_MARK).join('');
                    q.comment = (cleaned + PAID_MARK).substring(0, 800);
                    await q.save();
                }
            }
            await ctx.reply(
                `✅ To'lov qabul qilindi!\n\n💰 Summa: ${summa} so'm\n\n` +
                `Rahmat! Navbatingiz tasdiqlandi.`,
                { reply_markup: mainMenu }
            );
        } catch (e) {
            console.error('successful_payment xato:', e.message);
        }
    });

    // Navbatni bekor qilish (faqat bot orqali olingan, registratsiyasiz navbatlar)
    bot.callbackQuery(/^qc:(\d+)$/, async (ctx) => {
        try {
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) return ctx.answerCallbackQuery();
            const q = await QueueModel.findOne({ where: { id: Number(ctx.match[1]) } });
            if (!q || q.patient_id != p.id || q.deleted === 'queue_delete') {
                return ctx.answerCallbackQuery({ text: 'Navbat topilmadi.', show_alert: true });
            }
            if (q.reg_id) {
                return ctx.answerCallbackQuery({
                    text: 'Bu navbat klinikada rasmiylashtirilgan. Bekor qilish uchun klinikaga murojaat qiling.',
                    show_alert: true
                });
            }
            if (q.comment && q.comment.includes(PAID_MARK)) {
                return ctx.answerCallbackQuery({
                    text: 'To\'langan navbatni bot orqali bekor qilib bo\'lmaydi. Klinikaga murojaat qiling.',
                    show_alert: true
                });
            }
            // To'lov jarayoni boshlangan bo'lsa (Payme tranzaksiyasi ochiq) — kutish kerak
            if (await hasActivePaymeTxn(q.id)) {
                return ctx.answerCallbackQuery({
                    text: 'Bu navbat bo\'yicha to\'lov jarayoni ketmoqda. Birozdan so\'ng qaytadan urinib ko\'ring.',
                    show_alert: true
                });
            }
            // deletedQueue bilan bir xil holatga keltiramiz — joy bo'shaydi
            await releaseQueueRow(q);
            await ctx.answerCallbackQuery({ text: '✅ Navbat bekor qilindi.' }).catch(() => {});
            await ctx.editMessageText('❌ Navbat bekor qilindi. Yangi navbat olishingiz mumkin.').catch(() => {});
        } catch (e) {
            console.error('qc xato:', e.message);
        }
    });
}

module.exports = {
    registerNavbat,
    mainMenu,
    BTN_NAVBAT,
    BTN_MY,
    PAID_MARK,
    PENDING_MARK,
    BOT_COMMENT_PREFIX,
};
