// Click SHOP API endpointi (Prepare + Complete bitta URL da, `action` bilan ajratiladi).
// Hujjat: https://docs.click.uz/click-api-request/
//
// Click callback: POST https://payments.goldenvodiyclinic.uz/api/click
//   action = 0 -> Prepare  (to'lovdan oldin buyurtmani tekshirish)
//   action = 1 -> Complete (to'lov natijasi)
// Imzo: sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id +
//                        [merchant_prepare_id (faqat Complete)] + amount + action + sign_time)
// merchant_trans_id = queue_id (bot orqali olingan navbat IDsi).
const crypto = require('crypto');
const QueueModel = require('../models/queue.model');
const inspectionModel = require('../models/inspection.model');
const PatientModel = require('../models/patient.model');
const ClickTransactionModel = require('../models/click_transaction.model');
const config = require('../config');
const { PAID_MARK, PENDING_MARK } = require('../bot/navbat.bot');
const { newSendMessage } = require('../bot/bot.controller');

// Click xatolik kodlari
const ERR = {
    OK: 0,
    SIGN: -1,
    AMOUNT: -2,
    ACTION: -3,
    ALREADY_PAID: -4,
    NOT_FOUND: -5,          // buyurtma (navbat) topilmadi
    TRANSACTION_NOT_FOUND: -6,
    FAILED: -8,             // so'rovda xatolik
    CANCELED: -9,
};

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

class ClickController {

    handle = async (req, res) => {
        // Click ma'lumotni x-www-form-urlencoded ko'rinishda yuboradi
        const p = { ...(req.body || {}), ...(req.query || {}) };
        try {
            const action = Number(p.action);
            if (action === 0) {
                return res.json(await this.#prepare(p));
            }
            if (action === 1) {
                return res.json(await this.#complete(p));
            }
            return res.json({ error: ERR.ACTION, error_note: 'Action not found' });
        } catch (e) {
            console.error('Click endpoint xato:', e);
            return res.json({ error: ERR.FAILED, error_note: 'Internal error' });
        }
    }

    // Imzo tekshiruvi. `withPrepareId` = Complete bosqichida true
    #checkSign = (p, withPrepareId) => {
        const secret = (config.click_secret_key || '').trim();
        if (!secret) return false;
        const signString =
            String(p.click_trans_id) +
            String(p.service_id) +
            secret +
            String(p.merchant_trans_id) +
            (withPrepareId ? String(p.merchant_prepare_id) : '') +
            String(p.amount) +
            String(p.action) +
            String(p.sign_time);
        return md5(signString) === String(p.sign_string || '').toLowerCase();
    }

    // Navbat va summani tekshirish
    #validateOrder = async (merchantTransId, amount) => {
        const queueId = Number(merchantTransId);
        if (!queueId || !Number.isInteger(queueId)) {
            return { error: ERR.NOT_FOUND, error_note: 'Order not found' };
        }
        const queue = await QueueModel.findOne({ where: { id: queueId } });
        if (!queue || queue.deleted === 'queue_delete' || !queue.patient_id || !queue.ins_id) {
            return { error: ERR.NOT_FOUND, error_note: 'Order not found' };
        }
        if ((queue.comment || '').includes(PAID_MARK)) {
            return { error: ERR.ALREADY_PAID, error_note: 'Already paid' };
        }
        const ins = await inspectionModel.findOne({
            where: { id: queue.ins_id },
            attributes: ['id', 'name', 'price']
        });
        const expected = Number(ins ? ins.price : 0) || 0;
        if (expected <= 0) {
            return { error: ERR.NOT_FOUND, error_note: 'Order not found' };
        }
        // Click summani so'mda yuboradi (kasr bilan bo'lishi mumkin)
        if (Math.abs(Number(amount) - expected) > 0.01) {
            return { error: ERR.AMOUNT, error_note: 'Incorrect amount' };
        }
        return { queue, ins, expected };
    }

    // ===== Prepare (action = 0) =====
    #prepare = async (p) => {
        if (!this.#checkSign(p, false)) {
            return { error: ERR.SIGN, error_note: 'Sign check failed' };
        }
        const base = {
            click_trans_id: p.click_trans_id,
            merchant_trans_id: p.merchant_trans_id
        };
        const v = await this.#validateOrder(p.merchant_trans_id, p.amount);
        if (v.error !== undefined) return { ...base, merchant_prepare_id: 0, ...v };

        // Shu click_trans_id bo'yicha mavjud tranzaksiya - idempotent
        let txn = await ClickTransactionModel.findOne({
            where: { click_trans_id: String(p.click_trans_id) }
        });
        if (!txn) {
            txn = await ClickTransactionModel.create({
                click_trans_id: String(p.click_trans_id),
                queue_id: v.queue.id,
                amount: Number(p.amount),
                state: 1,
                prepare_time: Date.now()
            });
        } else if (txn.state !== 1) {
            return { ...base, merchant_prepare_id: txn.id, error: ERR.CANCELED, error_note: 'Transaction canceled' };
        }
        return { ...base, merchant_prepare_id: txn.id, error: ERR.OK, error_note: 'Success' };
    }

    // ===== Complete (action = 1) =====
    #complete = async (p) => {
        if (!this.#checkSign(p, true)) {
            return { error: ERR.SIGN, error_note: 'Sign check failed' };
        }
        const base = {
            click_trans_id: p.click_trans_id,
            merchant_trans_id: p.merchant_trans_id
        };
        const txn = await ClickTransactionModel.findOne({
            where: { id: Number(p.merchant_prepare_id) || 0 }
        });
        if (!txn || String(txn.click_trans_id) !== String(p.click_trans_id)) {
            return { ...base, merchant_confirm_id: 0, error: ERR.TRANSACTION_NOT_FOUND, error_note: 'Transaction not found' };
        }

        // Click tomonida to'lov muvaffaqiyatsiz bo'lsa (error < 0) - bekor qilamiz
        if (Number(p.error) < 0) {
            if (txn.state === 1) {
                txn.state = -1;
                txn.reason = Number(p.error);
                txn.cancel_time = Date.now();
                await txn.save();
            }
            return { ...base, merchant_confirm_id: txn.id, error: ERR.CANCELED, error_note: 'Transaction canceled' };
        }

        if (txn.state === 2) {
            // Idempotent - allaqachon bajarilgan
            return { ...base, merchant_confirm_id: txn.id, error: ERR.OK, error_note: 'Success' };
        }
        if (txn.state !== 1) {
            return { ...base, merchant_confirm_id: txn.id, error: ERR.CANCELED, error_note: 'Transaction canceled' };
        }

        // Summani yakuniy tekshirish
        const v = await this.#validateOrder(p.merchant_trans_id, p.amount);
        if (v.error !== undefined) {
            // ALREADY_PAID bo'lsa ham bu tranzaksiya hali complete bo'lmagan - xato qaytaramiz
            return { ...base, merchant_confirm_id: txn.id, ...v };
        }

        txn.state = 2;
        txn.perform_time = Date.now();
        await txn.save();

        // Navbatni "to'langan" qilish va bemorga xabar - xato bo'lsa ham Click'ka OK qaytadi
        try {
            await this.#markQueuePaid(txn);
        } catch (e) {
            console.error('Click markQueuePaid xato:', e.message);
        }
        return { ...base, merchant_confirm_id: txn.id, error: ERR.OK, error_note: 'Success' };
    }

    #markQueuePaid = async (t) => {
        const queue = await QueueModel.findOne({ where: { id: t.queue_id } });
        if (!queue || queue.deleted === 'queue_delete' || !queue.patient_id) {
            console.error(`Click: to'lov keldi, lekin navbat #${t.queue_id} topilmadi/bo'shatilgan. click_trans_id: ${t.click_trans_id}`);
            return;
        }
        if (!(queue.comment || '').includes(PAID_MARK)) {
            const cleaned = (queue.comment || '').split(PENDING_MARK).join('');
            queue.comment = (cleaned + PAID_MARK).substring(0, 800);
            await queue.save();
        }
        const p = await PatientModel.findOne({
            where: { id: queue.patient_id },
            attributes: ['id', 'chat_id']
        });
        if (p && p.chat_id) {
            const summa = Number(t.amount).toLocaleString('ru-RU');
            const d = new Date(queue.date_time * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            const sana = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
            const vaqt = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            await newSendMessage.sendTextUser(
                p.chat_id,
                `✅ To'lov qabul qilindi (Click) — navbatingiz tasdiqlandi!\n\n` +
                `💰 Summa: ${summa} so'm\n` +
                `📅 Sana: ${sana}\n` +
                `🕐 Vaqt: ${vaqt}\n` +
                `🔢 Navbat raqami: ${queue.number}\n\n` +
                `Iltimos belgilangan vaqtdan 10 daqiqa oldin keling.`
            );
        }
    }
}

module.exports = new ClickController;
