// Telegram bot orqali onlayn navbat olish.
// Bemor BITTA hizmatni tanlaydi, kun va vaqt tanlaydi. Bron qilinganda
// pay_order (to'lov buyurtmasi) yaratiladi: to'lanadigan summa — belgilangan
// bron puli (BOT_BRON_SUMMA), hizmatning qolgan qismi klinikada to'lanadi.
//
// MUHIM: to'lanmagan bron joyni BAND QILMAYDI — slot bo'sh ko'rinaveradi.
// Birinchi bo'lib to'lagan bemor joyni oladi; boshqa bemor shu slotni band
// qilsa, oldingi to'lanmagan bron va buyurtmasi avtomatik bekor bo'ladi.
// Slot sozlamalari .env dan: BOT_QUEUE_START (ish boshlanishi, raqamlash shundan),
// BOT_BOOKING_START (botda navbat olish boshlanishi), BOT_QUEUE_END, BOT_QUEUE_INTERVAL_MIN
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

const { BTN_GUIDE } = require('./qollanma.bot');

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
    .text(BTN_MY).row()
    .text(BTN_GUIDE)
    .resized();

const phoneKeyboard = new Keyboard()
    .requestContact('📱 Telefon raqamni yuborish')
    .row()
    .text(BTN_GUIDE)
    .resized();

// 'HH:MM' -> kun boshidan sekund
const parseTime = (str, def) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
    if (!m) return def;
    return Number(m[1]) * 3600 + Number(m[2]) * 60;
};
const QUEUE_START = parseTime(config.bot_queue_start, 8 * 3600);        // ish boshlanishi
const QUEUE_END = parseTime(config.bot_queue_end, 17 * 3600);           // ish tugashi
const INTERVAL = (Number(config.bot_queue_interval) || 10) * 60;        // slot davomiyligi (sek)
// Botda navbat olish shu vaqtdan boshlanadi (masalan ish 08:00 dan, bot 09:00 dan).
// Navbat raqami baribir QUEUE_START dan hisoblanadi — desktop bilan bir xil bo'lishi uchun.
// Interval to'riga tekislanadi: 08:00 + 10 daqiqa to'rida 09:00 -> №7.
const BOOKING_START = (() => {
    const b = parseTime(config.bot_booking_start, QUEUE_START);
    if (b <= QUEUE_START) return QUEUE_START;
    return QUEUE_START + Math.ceil((b - QUEUE_START) / INTERVAL) * INTERVAL;
})();
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
        { where: { queue_id: r.id, status: { [Op.in]: ['pending', 'confirmed'] } }, ...opts }
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

// Navbat raqami desktop formulasi bilan: vaqt = boshlanish + (raqam - 1) * interval,
// ya'ni ish 08:00 da boshlansa №1 = 08:00, №2 = 08:10 ... (10 daqiqalik to'rda)
const slotNumber = (slotOfDay) => {
    const n = Math.round((slotOfDay - QUEUE_START) / INTERVAL) + 1;
    return n < 1 ? 1 : n;
};

// Navbat bo'yicha aktiv (yaratilgan yoki to'langan) Payme/Click tranzaksiyasi bormi —
// bor bo'lsa bronni bo'shatib bo'lmaydi (pul yo'lda yoki olingan)
// To'lov uchun beriladigan vaqt (sek). Shu vaqt ichida tanlangan joy bemor uchun
// ushlab turiladi; to'lanmasa joy o'z-o'zidan bo'shaydi (queue qatori yo'q, faqat buyurtma)
const PAY_TIMEOUT_SEC = (Number(config.bot_pay_timeout) || 15) * 60;

// Buyurtma bo'yicha ochiq yoki to'langan Payme/Click tranzaksiyasi bormi
const hasActiveOrderTxn = async (orderId, transaction = null) => {
    const opts = transaction ? { transaction } : {};
    const txn = await PaymeTransactionModel.findOne({
        where: { order_id: orderId, state: { [Op.in]: [1, 2] } }, ...opts
    });
    if (txn) return true;
    const clickTxn = await ClickTransactionModel.findOne({
        where: { order_id: orderId, state: { [Op.in]: [1, 2] } }, ...opts
    });
    return !!clickTxn;
};

// [from, to) oralig'idagi joyni ushlab turgan to'lanmagan buyurtmalar:
// to'lov muddati o'tmagan yoki to'lov jarayoni (tranzaksiya) boshlangan
const holdingOrders = async (userId, from, to, transaction = null) => {
    const rows = await PayOrderModel.findAll({
        where: {
            user_id: userId,
            status: 'pending',
            queue_id: null,
            slot_time: { [Op.gte]: from, [Op.lt]: to }
        },
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
    });
    const out = [];
    for (const o of rows) {
        if (nowSec() - Number(o.created_at) < PAY_TIMEOUT_SEC || await hasActiveOrderTxn(o.id, transaction)) {
            out.push(o);
        }
    }
    return out;
};

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

// To'lov faqat yoqilgan (PAYMENTS_ENABLED=1) va kassa sozlangan bo'lsa talab qilinadi
const PAY_CONFIGURED = !!(config.payments_enabled && (PAYME_MERCHANT_ID || PAYME_TOKEN || CLICK_ENABLED));

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

// Hizmat tanlash klaviaturasi (bitta hizmat tanlanadi).
// style "primary" — tugma shaffof emas, to'liq ko'k rangda chiqadi
const buildServicesKeyboard = async () => {
    const inspections = await getBotInspections();
    if (!inspections.length) return null;
    const kb = new InlineKeyboard();
    for (const ins of inspections) {
        const price = Number(ins.price) ? ` — ${fmtSum(ins.price)} so'm` : '';
        kb.text(`${ins.name}${price}`, `qd:${ins.id}`).style('primary').row();
    }
    return { kb, text: '👨‍⚕️ Qaysi hizmatga navbat olmoqchisiz?' };
};

// ============================================================
// HODIMNING HAFTALIK ISH VAQTI (user.hikvision_setting)
// ============================================================
// [{ name, come_time, leave_time, disabled }] x 7, indeks = Date.getDay() (0 = Yakshanba).
// disabled = "Дам олиш". Botda navbat shu oraliqda olinadi.
// Ustun hali bazada bo'lmasa (server_pc da migratsiya qilinmagan) yoki jadval
// noto'g'ri bo'lsa — umumiy .env oralig'i (BOOKING_START..QUEUE_END) ishlatiladi.
const SCHEDULE_TTL_MS = 60 * 1000;
const scheduleCache = new Map(); // userId -> { at, value }

const hhmm = (str) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(str || '').trim());
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
};

const loadSchedule = async (userId) => {
    const c = scheduleCache.get(userId);
    if (c && Date.now() - c.at < SCHEDULE_TTL_MS) return c.value;
    let value = null;
    try {
        const [rows] = await sequelize.query(
            'SELECT hikvision_setting FROM user WHERE id = ?',
            { replacements: [userId] }
        );
        const raw = rows[0] && rows[0].hikvision_setting;
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length === 7) value = arr;
        }
    } catch (e) {
        if (!/Unknown column/i.test(e.message)) console.error('Ish vaqtini o\'qish xato:', e.message);
    }
    scheduleCache.set(userId, { at: Date.now(), value });
    return value;
};

// Shu kuni botda navbat olinadigan oraliq { start, end } (kun boshidan sekund)
// yoki null — dam olish kuni. Navbat raqami QUEUE_START dan hisoblangani uchun
// undan oldin slot bo'lmaydi va boshlanish interval to'riga tekislanadi.
const dayWindow = (schedule, day) => {
    if (!schedule) return { start: BOOKING_START, end: QUEUE_END };
    const s = schedule[new Date(day * 1000).getDay()];
    if (!s || s.disabled) return null;
    const come = hhmm(s.come_time);
    const leave = hhmm(s.leave_time);
    if (come === null || leave === null || leave <= come) return null;
    const from = Math.max(come, QUEUE_START);
    const start = QUEUE_START + Math.ceil((from - QUEUE_START) / INTERVAL) * INTERVAL;
    return start + INTERVAL <= leave ? { start, end: leave } : null;
};

// Kun tanlash klaviaturasi: bugundan boshlab DAYS_AHEAD kun, faqat hodimning ish kunlari
const buildDaysKeyboard = async (insId, userId) => {
    const schedule = await loadSchedule(userId);
    const kb = new InlineKeyboard();
    let count = 0;
    for (let i = 0; i < DAYS_AHEAD; i++) {
        const day = dayStartSec(i);
        const w = dayWindow(schedule, day);
        if (!w) continue; // dam olish kuni
        // bugun ish vaqti tugagan bo'lsa, bugunni ko'rsatmaymiz
        if (i === 0 && day + w.end - INTERVAL <= nowSec()) continue;
        const d = new Date(day * 1000);
        let label = `${fmtDate(day)} (${WEEKDAYS[d.getDay()]}) · ${fmtTime(w.start)}–${fmtTime(w.end)}`;
        if (i === 0) label = `Bugun — ${label}`;
        if (i === 1) label = `Ertaga — ${label}`;
        kb.text(label, `qs:${insId}:${day}`).row();
        count++;
    }
    kb.text('⬅️ Orqaga', 'qback').row();
    return { kb, count };
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
    const w = dayWindow(await loadSchedule(userId), day);
    // To'lovi kutilayotgan buyurtmalar ham joyni ushlab turadi (queue qatori hali yo'q)
    const holds = w ? await holdingOrders(userId, day + w.start, day + w.end) : [];
    const kb = new InlineKeyboard();
    let count = 0, hasFree = false;
    for (let t = w ? w.start : 0; w && t + INTERVAL <= w.end; t += INTERVAL) {
        const slotAbs = day + t;
        if (slotAbs <= nowSec()) continue; // o'tib ketgan slotlar ko'rsatilmaydi
        const busy = rows.some(r =>
            r.date_time >= slotAbs && r.date_time < slotAbs + INTERVAL &&
            isActiveBusy(r)
        ) || holds.some(o => o.slot_time >= slotAbs && o.slot_time < slotAbs + INTERVAL);
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
    return { kb, count, hasFree, dayOff: !w };
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
// NAVBAT QATORINI YARATISH (tranzaksiya ichida, slotRows qulflangan bo'lishi kerak)
// Desktop yaratgan bo'sh joy (type = 0) bo'lsa — uni band qiladi (raqami saqlanadi),
// aks holda raqam vaqtdan hisoblanib, oldingi bo'sh raqamlar to'ldiriladi (Gap Filling)
// ============================================================
const createQueueRow = async ({ transaction, slotRows, patientId, userId, insId, comment, slotAbs, day }) => {
    // Eski usuldagi muddati o'tgan to'lovsiz bronlar (queue qatori bilan) bo'shatiladi
    for (const r of slotRows) {
        if (r.deleted !== 'queue_delete' && isPendingUnpaid(r) && !(await hasActivePaymeTxn(r.id, transaction))) {
            await releaseQueueRow(r, transaction);
        }
    }
    const emptyRow = slotRows.find(r => r.deleted !== 'queue_delete' && !(r.type == 1 || r.patient_id));
    if (emptyRow) {
        emptyRow.patient_id = patientId;
        emptyRow.status = 'waiting';
        emptyRow.type = 1;
        emptyRow.comment = comment;
        emptyRow.deleted = '';
        emptyRow.show_tablo = true;
        emptyRow.ins_id = insId;
        emptyRow.bot_time = nowSec();
        await emptyRow.save({ transaction });
        return emptyRow;
    }
    const number = slotNumber(slotAbs - day);
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
                room_id: null, patient_id: null, number: i,
                date_time: day + QUEUE_START + (i - 1) * INTERVAL,
                status: 'waiting', user_id: userId, comment: '',
                type: 0, reg_id: null, deleted: '', show_tablo: true
            });
        }
        if (gaps.length) await QueueModel.bulkCreate(gaps, { transaction });
    }
    return QueueModel.create({
        room_id: null,
        patient_id: patientId,
        number,
        date_time: slotAbs,
        status: 'waiting',
        user_id: userId,
        comment,
        type: 1,
        reg_id: null,
        deleted: '',
        show_tablo: true,
        ins_id: insId,
        bot_time: nowSec()
    }, { transaction });
};

// ============================================================
// TO'LOV O'TGACH: buyurtma uchun navbat qatorini ochish
// (Payme/Click kontrollerlari chaqiradi). Tanlangan vaqt band bo'lib qolgan bo'lsa,
// shu kun ichidagi eng yaqin bo'sh vaqtga yoziladi (moved = true); umuman joy
// bo'lmasa — tanlangan vaqtga ogohlantirish belgisi bilan (forced = true).
// ============================================================
const confirmOrderQueue = async (order) => {
    if (order.queue_id) {
        return { queue: await QueueModel.findOne({ where: { id: order.queue_id } }), moved: false, forced: false };
    }
    if (!order.slot_time || !order.user_id) return { queue: null, moved: false, forced: false };
    const item = order.items && order.items[0];
    const insName = item ? item.name : '';
    const insId = item ? item.inspection_id : null;
    const userId = order.user_id;
    const slotAbs0 = Number(order.slot_time);
    const sd = new Date(slotAbs0 * 1000);
    sd.setHours(0, 0, 0, 0);
    const day = Math.floor(sd.getTime() / 1000);

    const transaction = await sequelize.transaction();
    try {
        const w = dayWindow(await loadSchedule(userId), day) || { start: BOOKING_START, end: QUEUE_END };
        const candidates = [slotAbs0];
        for (let t = slotAbs0 - day + INTERVAL; t + INTERVAL <= w.end; t += INTERVAL) candidates.push(day + t);

        let slotAbs = null, slotRows = null;
        for (const cand of candidates) {
            const rows = await QueueModel.findAll({
                where: {
                    user_id: userId,
                    date_time: { [Op.gte]: cand, [Op.lt]: cand + INTERVAL },
                    deleted: notDeleted
                },
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            let busy = false;
            for (const r of rows) {
                if (!(r.type == 1 || r.patient_id)) continue;
                if (isPendingUnpaid(r) && !(await hasActivePaymeTxn(r.id, transaction))) continue;
                busy = true;
                break;
            }
            if (!busy) {
                const holds = (await holdingOrders(userId, cand, cand + INTERVAL, transaction)).filter(o => o.id !== order.id);
                if (holds.length) busy = true;
            }
            if (!busy) { slotAbs = cand; slotRows = rows; break; }
        }
        let forced = false;
        if (slotAbs === null) {
            slotAbs = slotAbs0;
            slotRows = await QueueModel.findAll({
                where: {
                    user_id: userId,
                    date_time: { [Op.gte]: slotAbs, [Op.lt]: slotAbs + INTERVAL },
                    deleted: notDeleted
                },
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            forced = true;
        }
        const comment = (BOT_COMMENT_PREFIX + insName + PAID_MARK + (forced ? ' | ⚠️ vaqt band edi' : '')).substring(0, 800);
        const queue = await createQueueRow({
            transaction, slotRows,
            patientId: order.patient_id, userId, insId, comment, slotAbs, day
        });
        order.queue_id = queue.id;
        await order.save({ fields: ['queue_id'], transaction });
        await transaction.commit();
        return { queue, moved: slotAbs !== slotAbs0, forced };
    } catch (e) {
        await transaction.rollback();
        throw e;
    }
};

// ============================================================
// BRON QILISH (yadro): to'lov kerak bo'lsa faqat buyurtma, bo'lmasa navbat ham
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
                // O'zining to'lanmagan broni (eski usul) — bo'shatib, yangi tanlov bilan davom etamiz
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
        // O'zining shu kunga to'lanmagan buyurtmasi bo'lsa — yangi tanlov eskisini almashtiradi
        // (to'lov jarayoni boshlangan bo'lsa — kutish kerak)
        const myOrders = await PayOrderModel.findAll({
            where: {
                patient_id: p.id,
                user_id: userId,
                status: 'pending',
                queue_id: null,
                slot_time: { [Op.gte]: day, [Op.lte]: day + 86399 }
            },
            transaction
        });
        for (const o of myOrders) {
            if (await hasActiveOrderTxn(o.id, transaction)) {
                await transaction.rollback();
                await ctx.answerCallbackQuery({
                    text: 'Sizda bu kunga to\'lov jarayoni ketayotgan navbat bor. Birozdan so\'ng qaytadan urinib ko\'ring.',
                    show_alert: true
                }).catch(() => {});
                return;
            }
            o.status = 'canceled';
            await o.save({ transaction });
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
        // Boshqa bemorning to'lovi kutilayotgan buyurtmasi ham joyni ushlab turadi
        if (!busyRow) {
            const holds = await holdingOrders(userId, slotAbs, slotAbs + INTERVAL, transaction);
            if (holds.length) busyRow = holds[0];
        }
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
        if (payRequired) {
            // To'lov kerak: queue qatori YARATILMAYDI — dasturda to'lovgacha ko'rinmasin.
            // Tanlangan joy buyurtmada saqlanadi va PAY_TIMEOUT davomida ushlab turiladi;
            // to'lov o'tgach confirmOrderQueue() navbat qatorini ochadi.
            order = await PayOrderModel.create({
                patient_id: p.id,
                queue_id: null,
                user_id: userId,
                slot_time: slotAbs,
                total_summa: BRON_SUMMA,
                status: 'pending',
                created_at: nowSec()
            }, { transaction });
        } else {
            // To'lov talab qilinmaydi (kassa sozlanmagan yoki bron puli 0):
            // navbat darhol ochiladi, buyurtma 'confirmed' — backend uni
            // to'langandek registratsiyaga aylantiradi (kassaga summa tushmaydi)
            created = await createQueueRow({
                transaction, slotRows,
                patientId: p.id, userId, insId: ins.id,
                comment: (BOT_COMMENT_PREFIX + ins.name).substring(0, 800),
                slotAbs, day
            });
            order = await PayOrderModel.create({
                patient_id: p.id,
                queue_id: created.id,
                user_id: userId,
                slot_time: slotAbs,
                total_summa: 0,
                status: 'confirmed',
                created_at: nowSec()
            }, { transaction });
        }
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
        const timeoutMin = Math.round(PAY_TIMEOUT_SEC / 60);
        await ctx.answerCallbackQuery({
            text: `❗️ Navbat HALI TASDIQLANMADI!\n\nTasdiqlash uchun ${timeoutMin} daqiqa ichida ${fmtSum(BRON_SUMMA)} so'm bron to'lovini amalga oshiring.`,
            show_alert: true
        }).catch(() => {});
        confirmText =
            `❗️ NAVBAT HALI TASDIQLANMADI!\n\n` +
            `Navbatni olish uchun ${fmtSum(BRON_SUMMA)} so'm bron to'lovini ` +
            `quyidagi tugma orqali AMALGA OSHIRING 👇\n\n` +
            `🩺 Hizmat: ${ins.name}\n` +
            `📅 Sana: ${fmtDate(slotAbs)}\n` +
            `🕐 Vaqt: ${fmtTime(slotOfDay)} - ${fmtTime(slotOfDay + INTERVAL)}\n` +
            `🔢 Navbat raqami: ${slotNumber(slotOfDay)}\n\n` +
            `⏳ Joy siz uchun ${timeoutMin} daqiqa ushlab turiladi. To'lov qilinmasa joy bo'shaydi — ` +
            `boshqa bemor band qilishi mumkin.\n` +
            `Qolgan to'lov klinikada amalga oshiriladi.`;
        const kbPay = new InlineKeyboard();
        addPayButtons(kbPay, order.id, BRON_SUMMA);
        kbPay.text('❌ Bekor qilish', `qo:${order.id}`);
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
            config.payments_enabled
                ? "⚠️ To'lov tizimi sozlanmagan (.env da PAYME_MERCHANT_ID/CLICK_SERVICE_ID yo'q) — bot navbatlari to'lovsiz tasdiqlanadi."
                : "ℹ️ To'lov tizimi vaqtincha o'chirilgan (PAYMENTS_ENABLED=0) — bot navbatlari to'lovsiz tasdiqlanadi."
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
            const services = await buildServicesKeyboard();
            if (!services) {
                return ctx.reply('Hozircha onlayn navbat olish uchun hizmatlar mavjud emas.');
            }
            await ctx.reply(services.text, { reply_markup: services.kb });
        } catch (e) {
            console.error('BTN_NAVBAT xato:', e.message);
        }
    });

    // Orqaga: hizmatlar ro'yxatiga qaytish
    bot.callbackQuery('qback', async (ctx) => {
        try {
            await ctx.answerCallbackQuery().catch(() => {});
            const services = await buildServicesKeyboard();
            if (!services) return;
            await ctx.editMessageText(services.text, { reply_markup: services.kb });
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
            const days = await buildDaysKeyboard(ins.id, ins.user_id);
            await ctx.editMessageText(
                days.count
                    ? `🩺 ${ins.name}\n📅 Qaysi kunga navbat olmoqchisiz?`
                    : `🩺 ${ins.name}\n\nYaqin ${DAYS_AHEAD} kunda bu hizmat bo'yicha qabul kunlari yo'q. Boshqa hizmatni tanlang.`,
                { reply_markup: days.kb }
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
            const { kb, count, hasFree, dayOff } = await buildSlotsKeyboard(ins.id, ins.user_id, day);
            let text = `🩺 ${ins.name}\n🕐 ${fmtDate(day)} kuni uchun vaqtni tanlang:\n🟢 — bo'sh, 🔴 — band`;
            if (dayOff) text = `🩺 ${ins.name}\n${fmtDate(day)} — dam olish kuni. Boshqa kunni tanlang.`;
            else if (!count) text = `${fmtDate(day)} kuni uchun qabul vaqti tugagan.`;
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
            // Faqat botda ko'rsatiladigan slotlar: hodimning shu kungi ish vaqti ichida, interval to'rida
            const sd0 = new Date(slotAbs * 1000);
            sd0.setHours(0, 0, 0, 0);
            const day0 = Math.floor(sd0.getTime() / 1000);
            const slotOfDay0 = slotAbs - day0;
            const w0 = dayWindow(await loadSchedule(ins.user_id), day0);
            if (!w0 || slotOfDay0 < w0.start || slotOfDay0 + INTERVAL > w0.end ||
                (slotOfDay0 - QUEUE_START) % INTERVAL !== 0) {
                return ctx.answerCallbackQuery({
                    text: w0
                        ? `⛔ Bu kuni navbat ${fmtTime(w0.start)} dan ${fmtTime(w0.end)} gacha olinadi. Ro'yxatni yangilang.`
                        : '⛔ Bu kun — dam olish kuni. Ro\'yxatni yangilang.',
                    show_alert: true
                });
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
            // To'lovi kutilayotgan buyurtmalar (navbat qatori hali ochilmagan)
            const pendingOrders = await PayOrderModel.findAll({
                where: {
                    patient_id: p.id,
                    status: 'pending',
                    queue_id: null,
                    slot_time: { [Op.gte]: nowSec() }
                },
                include: [{ model: PayOrderItemModel, as: 'items' }],
                order: [['slot_time', 'ASC']]
            });
            if (!list.length && !pendingOrders.length) {
                return ctx.reply('Sizda faol navbat yo\'q.', { reply_markup: mainMenu });
            }
            // Navbatlarga bog'liq to'lov buyurtmalari (hizmat nomi va bron holati uchun)
            const orders = await PayOrderModel.findAll({
                where: {
                    queue_id: list.map(q => q.id),
                    status: { [Op.in]: ['pending', 'paid', 'confirmed'] }
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
            for (const o of pendingOrders) {
                const serviceName = (o.items || []).map(i => i.name).join(', ') || '-';
                const od = new Date(o.slot_time * 1000);
                const t = od.getHours() * 3600 + od.getMinutes() * 60;
                const leftMin = Math.ceil((Number(o.created_at) + PAY_TIMEOUT_SEC - nowSec()) / 60);
                const held = leftMin > 0 || await hasActiveOrderTxn(o.id);
                text += `\n⏳ ${serviceName}\n📅 ${fmtDate(o.slot_time)}  🕐 ${fmtTime(t)}  (№ ${slotNumber(t)})\n` +
                    `🔐 Bron: ${fmtSum(o.total_summa)} so'm — to'lanmagan` +
                    (held ? (leftMin > 0 ? `, joy yana ${leftMin} daqiqa saqlanadi` : '') : ', joy kafolatlanmagan') + '\n';
                addPayButtons(kb, o.id, Number(o.total_summa), `${fmtDate(o.slot_time)} ${fmtTime(t)}`);
                kb.text(`❌ ${fmtDate(o.slot_time)} ${fmtTime(t)} — bekor qilish`, `qo:${o.id}`).row();
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

    // To'lovi kutilayotgan buyurtmani (navbat qatori hali yo'q) bekor qilish
    bot.callbackQuery(/^qo:(\d+)$/, async (ctx) => {
        try {
            const p = await patient.getOneByChatId(ctx.chat.id);
            if (!p) return ctx.answerCallbackQuery();
            const o = await PayOrderModel.findOne({ where: { id: Number(ctx.match[1]) } });
            if (!o || o.patient_id != p.id || o.status !== 'pending') {
                return ctx.answerCallbackQuery({ text: 'Buyurtma topilmadi yoki allaqachon yakunlangan.', show_alert: true });
            }
            if (await hasActiveOrderTxn(o.id)) {
                return ctx.answerCallbackQuery({
                    text: 'Bu navbat bo\'yicha to\'lov jarayoni ketmoqda. Birozdan so\'ng qaytadan urinib ko\'ring.',
                    show_alert: true
                });
            }
            o.status = 'canceled';
            await o.save();
            await ctx.answerCallbackQuery({ text: '✅ Navbat bekor qilindi.' }).catch(() => {});
            await ctx.editMessageText('❌ Navbat bekor qilindi. Yangi navbat olishingiz mumkin.').catch(() => {});
        } catch (e) {
            console.error('qo xato:', e.message);
        }
    });
}

module.exports = {
    registerNavbat,
    confirmOrderQueue,
    mainMenu,
    BTN_NAVBAT,
    BTN_MY,
    PAID_MARK,
    PENDING_MARK,
    BOT_COMMENT_PREFIX,
};
