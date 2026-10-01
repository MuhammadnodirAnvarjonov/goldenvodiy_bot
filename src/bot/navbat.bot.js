// Telegram bot orqali onlayn navbat olish.
// Bemor BITTA hizmatni tanlaydi, kun va vaqt tanlaydi. Bron qilinganda
// pay_order (to'lov buyurtmasi) yaratiladi: to'lanadigan summa — belgilangan
// bron puli (BOT_BRON_SUMMA), hizmatning qolgan qismi klinikada to'lanadi.
//
// MUHIM: to'lanmagan bron joyni BAND QILMAYDI — slot bo'sh ko'rinaveradi.
// Birinchi bo'lib to'lagan bemor joyni oladi; boshqa bemor shu slotni band
// qilsa, oldingi to'lanmagan bron va buyurtmasi avtomatik bekor bo'ladi.
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
const PayOrderModel = require('../models/pay_order.model');
const PayOrderItemModel = require('../models/pay_order_item.model');
const patient = require('../services/patient.service');
const config = require('../config');

const BTN_NAVBAT = '📝 Navbat olish';
const BTN_MY = '📋 Mening navbatlarim';

// Bot orqali olingan navbat izohining boshi — hizmat nomi shu yerda saqlanadi
const BOT_COMMENT_PREFIX = 'Telegram bot: ';
// To'lov qilingan navbat izohiga qo'shiladigan belgi
const PAID_MARK = ' | ✅ To\'langan';
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
const fmtSum = (n) => Number(n || 0).toLocaleString('ru-RU');
// Bugungi kun boshi (server lokal vaqti) + offset kun, unix sekund
const dayStartSec = (offsetDays = 0) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) + offsetDays * 86400;
};
const nowSec = () => Math.floor(Date.now() / 1000);

// 'queue_delete' qilinmagan (aktiv) navbatlar sharti
const notDeleted = { [Op.or]: [{ [Op.is]: null }, { [Op.ne]: 'queue_delete' }] };

// Bron to'lovi (so'm) — navbatni tasdiqlash uchun oldindan to'lanadigan
// belgilangan summa. Hizmatning qolgan qismi klinikada to'lanadi.
const BRON_SUMMA = Number(config.bot_bron_summa) || 0;

// To'lanmagan bot broni (registratsiyasiz, "to'lov kutilmoqda")
// — bunday qator slotni BAND QILMAYDI
const isPendingUnpaid = (r) => {
    const c = r.comment || '';
    return !r.reg_id && c.includes(PENDING_MARK) && !c.includes(PAID_MARK);
};

// Qator slotni real band qiladimi (to'lanmagan bron band hisoblanmaydi)
const isActiveBusy = (r) => (r.type == 1 || r.patient_id) && !isPendingUnpaid(r);

// Bronni bo'shatish + bog'liq kutilayotgan to'lov buyurtmasini bekor qilish.
// Qator o'chirilmaydi — BO'SH JOYGA (type = 0) aylantiriladi: raqami va vaqti
// saqlanadi, desktop jadvalida "teshik" qolmaydi, keyingi bemor shu joyni oladi.
const releaseQueueRow = async (r, transaction = null) => {
    const opts = transaction ? { transaction } : {};
    await PayOrderModel.update(
        { status: 'canceled' },
        { where: { queue_id: r.id, status: 'pending' }, ...opts }
    );
    r.room_id = null;
    r.reg_id = null;
    r.patient_id = null;
    r.status = 'waiting';
    r.comment = '';
    r.type = 0;
    r.deleted = '';
    r.ins_id = null;
    r.bot_time = null;
    await r.save(opts);
};

// Navbat raqami desktop formulasi bilan: vaqt = boshlanish + raqam * interval
const slotNumber = (slotOfDay) => {
    const n = Math.round((slotOfDay - QUEUE_START) / INTERVAL);
    return n < 0 ? 0 : n;
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

// Vaqti o'tib ketgan to'lanmagan bronlarni tozalab turadi (jimgina, xabarsiz).
// To'lanmagan bron baribir joy band qilmaydi — bu faqat ro'yxat tozaligi uchun.
const releaseStalePending = async () => {
    try {
        const rows = await QueueModel.findAll({
            where: {
                reg_id: { [Op.is]: null },
                deleted: notDeleted,
                comment: { [Op.like]: `%${PENDING_MARK}%` },
                date_time: { [Op.lt]: nowSec() }
            }
        });
        for (const r of rows) {
            if ((r.comment || '').includes(PAID_MARK)) continue;
            if (await hasActivePaymeTxn(r.id)) continue;
            await releaseQueueRow(r);
        }
    } catch (e) {
        console.error('releaseStalePending xato:', e.message);
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

// ============================================================
// TO'LOV SOZLAMALARI
// ============================================================

// Telegram Payments (Payme provayderi) — zaxira usul
const PAYME_TOKEN = (config.payme_provider_token || '').trim();

// Payme Merchant API (kassa)
const PAYME_MERCHANT_ID = (config.payme_merchant_id || '').trim();

// Payme checkout sahifasiga GET-redirect link.
// Format: base64("m=<kassa>;ac.order_id=<buyurtma>;a=<summa tiyinda>;l=uz")
const PAYME_CHECKOUT_URL = (config.payme_checkout_url || 'https://checkout.paycom.uz').replace(/\/+$/, '');
const buildCheckoutUrl = (orderId, amountTiyin) => {
    const payload = `m=${PAYME_MERCHANT_ID};ac.order_id=${orderId};a=${amountTiyin};l=uz`;
    return PAYME_CHECKOUT_URL + '/' + Buffer.from(payload, 'utf8').toString('base64');
};

// Click yoqilganmi
const CLICK_ENABLED = !!(
    (config.click_service_id || '').trim() &&
    (config.click_merchant_id || '').trim() &&
    (config.click_secret_key || '').trim()
);

// Click to'lov sahifasi linki (transaction_param = order_id, summa so'mda)
const buildClickUrl = (orderId, amountSum) => {
    return 'https://my.click.uz/services/pay' +
        `?service_id=${encodeURIComponent(String(config.click_service_id).trim())}` +
        `&merchant_id=${encodeURIComponent(String(config.click_merchant_id).trim())}` +
        `&amount=${amountSum}` +
        `&transaction_param=${orderId}`;
};

const PAY_CONFIGURED = !!(PAYME_MERCHANT_ID || PAYME_TOKEN || CLICK_ENABLED);

// To'lov usullari tugmalari (buyurtma bo'yicha)
const addPayButtons = (kb, orderId, totalSum, label) => {
    if (PAYME_MERCHANT_ID) {
        kb.url(`💳 ${label ? label + ' — ' : ''}Payme orqali to'lash`, buildCheckoutUrl(orderId, Math.round(totalSum * 100))).row();
    }
    if (CLICK_ENABLED) {
        kb.url(`💳 ${label ? label + ' — ' : ''}Click orqali to'lash`, buildClickUrl(orderId, totalSum)).row();
    }
    if (!PAYME_MERCHANT_ID && !CLICK_ENABLED && PAYME_TOKEN) {
        // Zaxira: Telegram Payments hisob-fakturasi
        kb.text(`💳 ${label ? label + ' — ' : ''}To'lash`, `qp:${orderId}`).row();
    }
};

// Hizmat tanlash klaviaturasi (bitta hizmat tanlanadi)
const buildServicesKeyboard = async () => {
    const inspections = await getBotInspections();
    if (!inspections.length) return null;
    const kb = new InlineKeyboard();
    for (const ins of inspections) {
        const price = Number(ins.price) ? ` — ${fmtSum(ins.price)} so'm` : '';
        kb.text(`${ins.name}${price}`, `qd:${ins.id}`).row();
    }
    return kb;
};

const SERVICES_TEXT = '👨‍⚕️ Qaysi hizmatga navbat olmoqchisiz?';

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
// Bandlik hizmatga biriktirilgan hodim (userId) navbatlari bo'yicha aniqlanadi.
// To'lanmagan bronlar band hisoblanmaydi (birinchi to'lagan oladi).
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

// ============================================================
// BRON QILISH (yadro): navbat + to'lov buyurtmasi yaratadi
// ============================================================
const bookSlot = async (ctx, p, ins, slotAbs) => {
    const userId = ins.user_id;
    const price = Number(ins.price) || 0;
    // To'lov = belgilangan bron summasi (100% emas); qolgani klinikada to'lanadi
    const payRequired = !!(PAY_CONFIGURED && BRON_SUMMA > 0);

    const sd = new Date(slotAbs * 1000);
    sd.setHours(0, 0, 0, 0);
    const day = Math.floor(sd.getTime() / 1000);
    const slotOfDay = slotAbs - day;

    const transaction = await sequelize.transaction();
    let created = null;
    let order = null;
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
            if (isPendingUnpaid(mine) && !(await hasActivePaymeTxn(mine.id, transaction))) {
                // O'zining to'lanmagan broni — bo'shatib, yangi tanlov bilan davom etamiz
                await releaseQueueRow(mine, transaction);
            } else {
                await transaction.rollback();
                const t = mine.date_time - day;
                await ctx.answerCallbackQuery({
                    text: `Sizda bu kunga allaqachon navbat bor: ${fmtTime(t)}`,
                    show_alert: true
                }).catch(() => {});
                return;
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
        // Band qatorni aniqlaymiz; to'lanmagan bronlar bo'shatiladi
        // (to'lov jarayoni ketayotganlari band hisoblanadi)
        let busyRow = null;
        for (const r of slotRows) {
            if (r.deleted === 'queue_delete') continue;
            if (!(r.type == 1 || r.patient_id)) continue; // oldindan ochilgan bo'sh joy
            if (isPendingUnpaid(r)) {
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
            // Navbat raqami desktop formulasi bilan: (vaqt - ish boshlanishi) / interval
            const number = slotNumber(slotOfDay);

            // Bo'shliqlarni to'ldirish (desktop "Gap Filling" bilan bir xil):
            // shu kunda shu hodimda 1..number-1 oralig'ida qatori yo'q raqamlar
            // uchun bo'sh joy (type = 0) yaratiladi - jadval to'liq ko'rinadi
            if (number > 1) {
                const dayRows = await QueueModel.findAll({
                    where: {
                        user_id: userId,
                        date_time: { [Op.gte]: day, [Op.lte]: day + 86399 },
                        deleted: notDeleted
                    },
                    attributes: ['number'],
                    transaction
                });
                const taken = new Set(dayRows.map(r => Number(r.number)));
                const gaps = [];
                for (let i = 1; i < number; i++) {
                    if (taken.has(i)) continue;
                    gaps.push({
                        room_id: null,
                        patient_id: null,
                        number: i,
                        date_time: day + QUEUE_START + i * INTERVAL,
                        status: 'waiting',
                        user_id: userId,
                        comment: '',
                        type: 0,
                        reg_id: null,
                        deleted: '',
                        show_tablo: true
                    });
                }
                if (gaps.length) {
                    await QueueModel.bulkCreate(gaps, { transaction });
                }
            }

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

        // To'lov buyurtmasi: to'lanadigan summa = bron puli;
        // hizmat (haqiqiy narxi bilan) itemda saqlanadi
        order = await PayOrderModel.create({
            patient_id: p.id,
            queue_id: created.id,
            total_summa: payRequired ? BRON_SUMMA : 0,
            status: 'pending',
            created_at: nowSec()
        }, { transaction });
        await PayOrderItemModel.create({
            order_id: order.id,
            inspection_id: ins.id,
            name: ins.name,
            price: price
        }, { transaction });

        await transaction.commit();
    } catch (err) {
        await transaction.rollback();
        throw err;
    }

    let confirmText;
    const opts = {};
    if (payRequired) {
        // Navbat faqat TO'LOVDAN KEYIN kafolatlanadi.
        // Bemor "navbat olindi" deb o'ylab qolmasligi uchun: majburiy (modal)
        // ogohlantirish + xabarda birinchi bo'lib to'lov talabi va tugmalari
        await ctx.answerCallbackQuery({
            text: `❗️ Navbat HALI TASDIQLANMADI!\n\nTasdiqlash uchun ${fmtSum(BRON_SUMMA)} so'm bron to'lovini amalga oshiring.`,
            show_alert: true
        }).catch(() => {});
        confirmText =
            `❗️ NAVBAT HALI TASDIQLANMADI!\n\n` +
            `Navbatni olish uchun ${fmtSum(BRON_SUMMA)} so'm bron to'lovini ` +
            `quyidagi tugma orqali AMALGA OSHIRING 👇\n\n` +
            `🩺 Hizmat: ${ins.name}\n` +
            `📅 Sana: ${fmtDate(slotAbs)}\n` +
            `🕐 Vaqt: ${fmtTime(slotOfDay)} - ${fmtTime(slotOfDay + INTERVAL)}\n` +
            `🔢 Navbat raqami: ${created.number}\n\n` +
            `⚠️ To'lov qilinmasa joy SIZGA SAQLANMAYDI — boshqa bemor band qilishi mumkin.\n` +
            `Qolgan to'lov klinikada amalga oshiriladi.`;
        const kbPay = new InlineKeyboard();
        addPayButtons(kbPay, order.id, BRON_SUMMA);
        kbPay.text('❌ Bekor qilish', `qc:${created.id}`);
        opts.reply_markup = kbPay;
    } else {
        // To'lov talab qilinmaydi (kassa sozlanmagan yoki bron puli 0)
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
};

function registerNavbat(bot) {
    // To'lov tizimi sozlanmagan bo'lsa — bot navbatlari TO'LOVSIZ beriladi
    if (!PAY_CONFIGURED) {
        console.warn(
            "⚠️ To'lov tizimi sozlanmagan (.env da PAYME_MERCHANT_ID/CLICK_SERVICE_ID yo'q) — " +
            "bot navbatlari to'lovsiz tasdiqlanadi. To'lov majburiy bo'lishi uchun " +
            "kassa ma'lumotlarini .env ga kiriting."
        );
    }
    // Vaqti o'tgan to'lanmagan bronlarni tozalab turish (har 10 daqiqada, jimgina)
    setInterval(releaseStalePending, 10 * 60 * 1000);
    releaseStalePending();

    // 1-qadam: hizmat tanlash (bitta)
    bot.hears(BTN_NAVBAT, async (ctx) => {
        try {
            const p = await requirePatient(ctx);
            if (!p) return;
            const kb = await buildServicesKeyboard();
            if (!kb) {
                return ctx.reply('Hozircha onlayn navbat olish uchun hizmatlar mavjud emas.');
            }
            await ctx.reply(SERVICES_TEXT, { reply_markup: kb });
        } catch (e) {
            console.error('BTN_NAVBAT xato:', e.message);
        }
    });

    // Orqaga: hizmatlar ro'yxatiga qaytish
    bot.callbackQuery('qback', async (ctx) => {
        try {
            await ctx.answerCallbackQuery().catch(() => {});
            const kb = await buildServicesKeyboard();
            if (!kb) return;
            await ctx.editMessageText(SERVICES_TEXT, { reply_markup: kb });
        } catch (e) {
            console.error('qback xato:', e.message);
        }
    });

    // 2-qadam: kun tanlash
    bot.callbackQuery(/^qd:(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCallbackQuery().catch(() => {});
            const ins = await getInspection(Number(ctx.match[1]));
            if (!ins) {
                return ctx.editMessageText('Bu hizmat endi mavjud emas. Qaytadan tanlang: /start').catch(() => {});
            }
            await ctx.editMessageText(
                `🩺 ${ins.name}\n📅 Qaysi kunga navbat olmoqchisiz?`,
                { reply_markup: buildDaysKeyboard(ins.id) }
            );
        } catch (e) {
            console.error('qd xato:', e.message);
        }
    });

    // 3-qadam: slotlarni ko'rsatish
    bot.callbackQuery(/^qs:(\d+):(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCallbackQuery().catch(() => {});
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

    // 4-qadam: navbatga yozish (+ to'lov buyurtmasi)
    bot.callbackQuery(/^qb:(\d+):(\d+)$/, async (ctx) => {
        try {
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) {
                return ctx.answerCallbackQuery({ text: 'Avval ro\'yxatdan o\'ting.', show_alert: true });
            }
            const ins = await getInspection(Number(ctx.match[1]));
            const slotAbs = Number(ctx.match[2]);
            if (!ins) {
                return ctx.answerCallbackQuery({ text: 'Bu hizmat endi mavjud emas.', show_alert: true });
            }
            if (slotAbs <= nowSec()) {
                return ctx.answerCallbackQuery({ text: '⛔ Bu vaqt o\'tib ketdi.', show_alert: true });
            }
            await bookSlot(ctx, p, ins, slotAbs);
        } catch (e) {
            console.error('qb xato:', e.message);
            await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.', show_alert: true }).catch(() => {});
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
            // Navbatlarga bog'liq to'lov buyurtmalari (hizmat nomi va bron holati uchun)
            const orders = await PayOrderModel.findAll({
                where: {
                    queue_id: list.map(q => q.id),
                    status: { [Op.in]: ['pending', 'paid'] }
                },
                include: [{ model: PayOrderItemModel, as: 'items' }]
            });
            const orderByQueue = new Map();
            for (const o of orders) {
                const prev = orderByQueue.get(o.queue_id);
                if (!prev || o.id > prev.id) orderByQueue.set(o.queue_id, o);
            }

            let text = '📋 Sizning navbatlaringiz:\n';
            const kb = new InlineKeyboard();
            for (const q of list) {
                const order = orderByQueue.get(q.id);
                let serviceName;
                if (order && order.items && order.items.length) {
                    serviceName = order.items.map(i => i.name).join(', ');
                } else if (q.comment && q.comment.startsWith(BOT_COMMENT_PREFIX)) {
                    serviceName = q.comment.slice(BOT_COMMENT_PREFIX.length).split(' | ')[0];
                } else {
                    const u = q.user;
                    serviceName = u ? (u.doctor ? u.doctor.name : (u.inspecton ? u.inspecton.name : u.user_name)) : '-';
                }
                const qd = new Date(q.date_time * 1000);
                const t = qd.getHours() * 3600 + qd.getMinutes() * 60;
                const paid = (q.comment || '').includes(PAID_MARK) || (order && order.status === 'paid');
                text += `\n👨‍⚕️ ${serviceName}\n📅 ${fmtDate(q.date_time)}  🕐 ${fmtTime(t)}  (№ ${q.number})`;
                if (order && Number(order.total_summa) > 0) {
                    text += `\n🔐 Bron: ${fmtSum(order.total_summa)} so'm ${paid ? '— ✅ to\'langan' : '— ⏳ to\'lanmagan (joy kafolatlanmagan)'}`;
                }
                text += '\n';
                // Faqat bot orqali olingan (registratsiyasiz, to'lanmagan) kelajakdagi navbat
                if (!q.reg_id && q.date_time > nowSec() && !paid) {
                    if (order && Number(order.total_summa) > 0) {
                        addPayButtons(kb, order.id, Number(order.total_summa), `${fmtDate(q.date_time)} ${fmtTime(t)}`);
                    }
                    kb.text(`❌ ${fmtDate(q.date_time)} ${fmtTime(t)} — bekor qilish`, `qc:${q.id}`).row();
                }
            }
            await ctx.reply(text, { reply_markup: kb.inline_keyboard.length ? kb : mainMenu });
        } catch (e) {
            console.error('BTN_MY xato:', e.message);
        }
    });

    // Zaxira to'lov (Telegram Payments invoice) — buyurtma bo'yicha
    bot.callbackQuery(/^qp:(\d+)$/, async (ctx) => {
        try {
            if (!PAYME_TOKEN) {
                return ctx.answerCallbackQuery({ text: 'Onlayn to\'lov hozircha yoqilmagan.', show_alert: true });
            }
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) return ctx.answerCallbackQuery();
            const order = await PayOrderModel.findOne({
                where: { id: Number(ctx.match[1]) },
                include: [{ model: PayOrderItemModel, as: 'items' }]
            });
            if (!order || order.patient_id != p.id || order.status === 'canceled') {
                return ctx.answerCallbackQuery({ text: 'Buyurtma topilmadi yoki bekor qilingan.', show_alert: true });
            }
            if (order.status === 'paid') {
                return ctx.answerCallbackQuery({ text: '✅ Bu buyurtma allaqachon to\'langan.', show_alert: true });
            }
            const total = Number(order.total_summa) || 0;
            if (total <= 0) {
                return ctx.answerCallbackQuery({ text: 'Bu buyurtma uchun onlayn to\'lov mavjud emas.', show_alert: true });
            }
            await ctx.answerCallbackQuery().catch(() => {});
            const title = (order.items && order.items.length ? order.items[0].name : 'Klinika navbat broni');
            // Telegram: title <= 32, description <= 255 belgi; amount tiyinda (so'm * 100)
            await ctx.replyWithInvoice(
                title.substring(0, 32),
                `Buyurtma #${order.id} — navbat broni`.substring(0, 255),
                `pay:${order.id}`,
                'UZS',
                [{ label: 'Bron', amount: Math.round(total * 100) }],
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
            const m = /^pay:(\d+)$/.exec(ctx.preCheckoutQuery.invoice_payload || '');
            if (!m) {
                return ctx.answerPreCheckoutQuery(false, 'To\'lov ma\'lumotlari noto\'g\'ri.');
            }
            const order = await PayOrderModel.findOne({ where: { id: Number(m[1]) } });
            if (!order || order.status === 'canceled') {
                return ctx.answerPreCheckoutQuery(false, 'Buyurtma topilmadi yoki bekor qilingan.');
            }
            if (order.status === 'paid') {
                return ctx.answerPreCheckoutQuery(false, 'Bu buyurtma allaqachon to\'langan.');
            }
            await ctx.answerPreCheckoutQuery(true);
        } catch (e) {
            console.error('pre_checkout xato:', e.message);
            await ctx.answerPreCheckoutQuery(false, 'Xatolik yuz berdi. Qaytadan urinib ko\'ring.').catch(() => {});
        }
    });

    // Muvaffaqiyatli to'lov (Telegram Payments) — buyurtma va navbat "to'langan"
    bot.on('message:successful_payment', async (ctx) => {
        try {
            const sp = ctx.message.successful_payment;
            const m = /^pay:(\d+)$/.exec(sp.invoice_payload || '');
            const summa = (sp.total_amount / 100).toLocaleString('ru-RU');
            if (m) {
                const order = await PayOrderModel.findOne({ where: { id: Number(m[1]) } });
                if (order && order.status !== 'paid') {
                    order.status = 'paid';
                    order.pay_type = 'payme';
                    order.paid_time = Date.now();
                    await order.save();
                    if (order.queue_id) {
                        const q = await QueueModel.findOne({ where: { id: order.queue_id } });
                        if (q && !(q.comment || '').includes(PAID_MARK)) {
                            const cleaned = (q.comment || '').split(PENDING_MARK).join('');
                            q.comment = (cleaned + PAID_MARK).substring(0, 800);
                            await q.save();
                        }
                    }
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
            // To'lov jarayoni boshlangan bo'lsa (Payme/Click tranzaksiyasi ochiq) — kutish kerak
            if (await hasActivePaymeTxn(q.id)) {
                return ctx.answerCallbackQuery({
                    text: 'Bu navbat bo\'yicha to\'lov jarayoni ketmoqda. Birozdan so\'ng qaytadan urinib ko\'ring.',
                    show_alert: true
                });
            }
            // deletedQueue bilan bir xil holatga keltiramiz — joy bo'shaydi, buyurtma bekor bo'ladi
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
