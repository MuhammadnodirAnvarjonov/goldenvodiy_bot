// Payme Merchant API (JSON-RPC) endpointi.
// Hujjat: https://developer.help.paycom.uz/protokol-merchant-api/
//
// Payme shu endpointga POST so'rov yuboradi (Authorization: Basic <base64(login:KEY)>).
// Account parametri: queue_id — Telegram bot orqali olingan navbat IDsi.
// To'lov muvaffaqiyatli bo'lsa (PerformTransaction) navbat izohiga "To'langan (Payme)"
// belgisi qo'yiladi va bemorga Telegram orqali xabar yuboriladi.
//
// Tranzaksiya holatlari (payme_transaction.state):
//   1 = yaratilgan (to'lov kutilmoqda)
//   2 = to'langan
//  -1 = to'lovdan oldin bekor qilingan
//  -2 = to'lovdan keyin qaytarilgan (refund)
const { Op } = require('sequelize');
const UserModel = require('../models/user.model');
const QueueModel = require('../models/queue.model');
const inspectionModel = require('../models/inspection.model');
const PatientModel = require('../models/patient.model');
const PaymeTransactionModel = require('../models/payme_transaction.model');
const config = require('../config');
const { PAID_MARK, PENDING_MARK } = require('../bot/navbat.bot');
const { newSendMessage } = require('../bot/bot.controller');

// Tranzaksiya yaroqlilik muddati — 12 soat (Payme standarti), millisekundda
const TIME_EXPIRED = 43200000;

// Bekor qilish sabablari ichida "timeout" kodi
const REASON_EXPIRED = 4;

// ===== Xatolik kodlari (Payme protokoli) =====
const ERR = {
    AUTH: -32504,               // Authorization noto'g'ri
    METHOD_NOT_FOUND: -32601,
    INVALID_AMOUNT: -31001,
    TRANSACTION_NOT_FOUND: -31003,
    CANT_PERFORM: -31008,
    // Account xatolari -31050..-31099 oralig'ida bo'lishi shart
    QUEUE_NOT_FOUND: -31050,
    ALREADY_PAID: -31051,
    QUEUE_BUSY: -31099,
};

const msg = (ru, uz, en) => ({ ru, uz, en });

// JSON-RPC xatolik obyekti (throw qilinadi va dispatcherda ushlanadi)
class PaymeError extends Error {
    constructor(code, message, data = null) {
        super(typeof message === 'object' ? message.uz : String(message));
        this.isPaymeError = true;
        this.code = code;
        this.rpcMessage = message;
        this.data = data;
    }
}

class PaymeController {

    // Barcha so'rovlar shu yerga tushadi
    handle = async (req, res) => {
        const body = req.body || {};
        const id = body.id !== undefined ? body.id : null;
        try {
            this.#checkAuth(req);
            const params = body.params || {};
            let result;
            switch (body.method) {
                case 'CheckPerformTransaction':
                    result = await this.#checkPerformTransaction(params);
                    break;
                case 'CreateTransaction':
                    result = await this.#createTransaction(params);
                    break;
                case 'PerformTransaction':
                    result = await this.#performTransaction(params);
                    break;
                case 'CancelTransaction':
                    result = await this.#cancelTransaction(params);
                    break;
                case 'CheckTransaction':
                    result = await this.#checkTransaction(params);
                    break;
                case 'GetStatement':
                    result = await this.#getStatement(params);
                    break;
                default:
                    throw new PaymeError(
                        ERR.METHOD_NOT_FOUND,
                        msg('Метод не найден', 'Usul topilmadi', 'Method not found')
                    );
            }
            return res.status(200).json({ result, id });
        } catch (e) {
            if (e.isPaymeError) {
                return res.status(200).json({
                    error: { code: e.code, message: e.rpcMessage, data: e.data },
                    id
                });
            }
            console.error('Payme endpoint xato:', e);
            return res.status(200).json({
                error: {
                    code: ERR.CANT_PERFORM,
                    message: msg('Внутренняя ошибка', 'Ichki xatolik', 'Internal error'),
                    data: null
                },
                id
            });
        }
    }

    // Authorization: Basic base64(login:KEY) — parol PAYME_KEY yoki PAYME_TEST_KEY
    // bilan mos kelishi kerak
    #checkAuth = (req) => {
        const header = req.headers['authorization'] || '';
        const authError = new PaymeError(
            ERR.AUTH,
            msg('Недостаточно привилегий', 'Ruxsat yo\'q', 'Insufficient privileges')
        );
        if (!header.startsWith('Basic ')) throw authError;
        let decoded = '';
        try {
            decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        } catch (_) {
            throw authError;
        }
        const sep = decoded.indexOf(':');
        const password = sep >= 0 ? decoded.slice(sep + 1) : '';
        const keys = [config.payme_key, config.payme_test_key]
            .map(k => (k || '').trim())
            .filter(k => k.length > 0);
        if (!keys.length || !keys.includes(password)) throw authError;
    }

    // Account + summa tekshiruvi. Muvaffaqiyatda { queue, ins, amount } qaytaradi.
    #validateAccount = async (account, amount) => {
        const notFound = new PaymeError(
            ERR.QUEUE_NOT_FOUND,
            msg('Заказ не найден', 'Navbat topilmadi', 'Order not found'),
            'queue_id'
        );
        const queueId = Number(account && account.queue_id);
        if (!queueId || !Number.isInteger(queueId)) throw notFound;

        const queue = await QueueModel.findOne({ where: { id: queueId } });
        if (!queue || queue.deleted === 'queue_delete' || !queue.patient_id) throw notFound;
        if ((queue.comment || '').includes(PAID_MARK)) {
            throw new PaymeError(
                ERR.ALREADY_PAID,
                msg('Заказ уже оплачен', 'Bu navbat allaqachon to\'langan', 'Order already paid'),
                'queue_id'
            );
        }
        if (!queue.ins_id) throw notFound;
        const ins = await inspectionModel.findOne({
            where: { id: queue.ins_id },
            attributes: ['id', 'name', 'price']
        });
        if (!ins) throw notFound;

        const expected = Math.round((Number(ins.price) || 0) * 100); // tiyinda
        if (expected <= 0) throw notFound;
        if (Number(amount) !== expected) {
            throw new PaymeError(
                ERR.INVALID_AMOUNT,
                msg('Неверная сумма', 'Summa noto\'g\'ri', 'Incorrect amount'),
                'amount'
            );
        }
        return { queue, ins, amount: expected };
    }

    // ===== CheckPerformTransaction =====
    #checkPerformTransaction = async (params) => {
        const { ins, amount } = await this.#validateAccount(params.account, params.amount);
        const result = { allow: true };
        // Soliq (fiskal) ma'lumotlari — MXIK kodi sozlangan bo'lsa qaytariladi
        const mxik = (config.payme_mxik_code || '').trim();
        if (mxik) {
            result.detail = {
                receipt_type: 0,
                items: [{
                    title: ins.name,
                    price: amount,
                    count: 1,
                    code: mxik,
                    package_code: (config.payme_package_code || '').trim(),
                    vat_percent: Number(config.payme_vat_percent) || 0
                }]
            };
        }
        return result;
    }

    // ===== CreateTransaction =====
    #createTransaction = async (params) => {
        const existing = await PaymeTransactionModel.findOne({
            where: { paycom_transaction_id: String(params.id) }
        });
        if (existing) {
            if (existing.state != 1) {
                throw new PaymeError(
                    ERR.CANT_PERFORM,
                    msg('Невозможно выполнить операцию', 'Amalni bajarib bo\'lmaydi', 'Unable to perform operation')
                );
            }
            if (Date.now() - Number(existing.paycom_time) > TIME_EXPIRED) {
                existing.state = -1;
                existing.reason = REASON_EXPIRED;
                existing.cancel_time = Date.now();
                await existing.save();
                throw new PaymeError(
                    ERR.CANT_PERFORM,
                    msg('Транзакция просрочена', 'Tranzaksiya muddati o\'tgan', 'Transaction expired')
                );
            }
            return {
                create_time: Number(existing.create_time),
                transaction: String(existing.id),
                state: 1,
                receivers: null
            };
        }

        // Yangi tranzaksiya — account va summa qayta tekshiriladi
        const { queue } = await this.#validateAccount(params.account, params.amount);

        // Payme yuborgan vaqt bo'yicha muddat tekshiruvi
        if (Date.now() - Number(params.time) > TIME_EXPIRED) {
            throw new PaymeError(
                ERR.CANT_PERFORM,
                msg('Транзакция просрочена', 'Tranzaksiya muddati o\'tgan', 'Transaction expired')
            );
        }

        // Bitta navbat uchun bir vaqtda faqat bitta aktiv tranzaksiya
        const busy = await PaymeTransactionModel.findOne({
            where: { queue_id: queue.id, state: 1 }
        });
        if (busy) {
            throw new PaymeError(
                ERR.QUEUE_BUSY,
                msg(
                    'По этому заказу уже ожидается другая оплата',
                    'Bu navbat uchun boshqa to\'lov kutilmoqda',
                    'Another payment is pending for this order'
                ),
                'queue_id'
            );
        }

        const model = await PaymeTransactionModel.create({
            paycom_transaction_id: String(params.id),
            paycom_time: Number(params.time),
            queue_id: queue.id,
            amount: Number(params.amount),
            state: 1,
            create_time: Date.now()
        });
        return {
            create_time: Number(model.create_time),
            transaction: String(model.id),
            state: 1,
            receivers: null
        };
    }

    // ===== PerformTransaction =====
    #performTransaction = async (params) => {
        const model = await this.#findTransaction(params.id);
        if (model.state == 2) {
            // Idempotent — allaqachon bajarilgan
            return {
                transaction: String(model.id),
                perform_time: Number(model.perform_time),
                state: 2
            };
        }
        if (model.state != 1) {
            throw new PaymeError(
                ERR.CANT_PERFORM,
                msg('Невозможно выполнить операцию', 'Amalni bajarib bo\'lmaydi', 'Unable to perform operation')
            );
        }
        if (Date.now() - Number(model.paycom_time) > TIME_EXPIRED) {
            model.state = -1;
            model.reason = REASON_EXPIRED;
            model.cancel_time = Date.now();
            await model.save();
            throw new PaymeError(
                ERR.CANT_PERFORM,
                msg('Транзакция просрочена', 'Tranzaksiya muddati o\'tgan', 'Transaction expired')
            );
        }
        model.state = 2;
        model.perform_time = Date.now();
        await model.save();

        // Navbatni "to'langan" deb belgilash va bemorga xabar yuborish.
        // Xato bo'lsa ham Payme'ga muvaffaqiyat qaytariladi — pul allaqachon olingan.
        try {
            await this.#markQueuePaid(model);
        } catch (e) {
            console.error('Payme markQueuePaid xato:', e.message);
        }
        return {
            transaction: String(model.id),
            perform_time: Number(model.perform_time),
            state: 2
        };
    }

    // ===== CancelTransaction =====
    #cancelTransaction = async (params) => {
        const model = await this.#findTransaction(params.id);
        if (model.state == 1) {
            model.state = -1;
            model.reason = params.reason !== undefined ? Number(params.reason) : null;
            model.cancel_time = Date.now();
            await model.save();
        } else if (model.state == 2) {
            // To'lovdan keyin qaytarish (refund) — navbatdan "to'langan" belgisi olinadi
            model.state = -2;
            model.reason = params.reason !== undefined ? Number(params.reason) : null;
            model.cancel_time = Date.now();
            await model.save();
            try {
                await this.#unmarkQueuePaid(model);
            } catch (e) {
                console.error('Payme unmarkQueuePaid xato:', e.message);
            }
        }
        // state -1/-2 bo'lsa idempotent — mavjud holat qaytariladi
        return {
            transaction: String(model.id),
            cancel_time: Number(model.cancel_time),
            state: Number(model.state)
        };
    }

    // ===== CheckTransaction =====
    #checkTransaction = async (params) => {
        const model = await this.#findTransaction(params.id);
        return {
            create_time: Number(model.create_time),
            perform_time: Number(model.perform_time),
            cancel_time: Number(model.cancel_time),
            transaction: String(model.id),
            state: Number(model.state),
            reason: model.reason === null || model.reason === undefined ? null : Number(model.reason)
        };
    }

    // ===== GetStatement =====
    #getStatement = async (params) => {
        const from = Number(params.from) || 0;
        const to = Number(params.to) || Date.now();
        const list = await PaymeTransactionModel.findAll({
            where: {
                paycom_time: { [Op.gte]: from, [Op.lte]: to }
            },
            order: [['paycom_time', 'ASC']]
        });
        return {
            transactions: list.map(t => ({
                id: t.paycom_transaction_id,
                time: Number(t.paycom_time),
                amount: Number(t.amount),
                account: { queue_id: String(t.queue_id) },
                create_time: Number(t.create_time),
                perform_time: Number(t.perform_time),
                cancel_time: Number(t.cancel_time),
                transaction: String(t.id),
                state: Number(t.state),
                reason: t.reason === null || t.reason === undefined ? null : Number(t.reason),
                receivers: null
            }))
        };
    }

    #findTransaction = async (paycomId) => {
        const model = await PaymeTransactionModel.findOne({
            where: { paycom_transaction_id: String(paycomId) }
        });
        if (!model) {
            throw new PaymeError(
                ERR.TRANSACTION_NOT_FOUND,
                msg('Транзакция не найдена', 'Tranzaksiya topilmadi', 'Transaction not found')
            );
        }
        return model;
    }

    // To'lov o'tdi: bron tasdiqlanadi ("to'lov kutilmoqda" belgisi olinadi,
    // "to'langan" qo'yiladi) va bemorga Telegram xabar yuboriladi
    #markQueuePaid = async (t) => {
        const queue = await QueueModel.findOne({ where: { id: t.queue_id } });
        if (!queue || queue.deleted === 'queue_delete' || !queue.patient_id) {
            // Juda kam holat: to'lov kelguncha bron bo'shatilgan
            console.error(`Payme: to'lov keldi, lekin navbat #${t.queue_id} topilmadi/bo'shatilgan. Tranzaksiya: ${t.paycom_transaction_id}`);
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
            const summa = (Number(t.amount) / 100).toLocaleString('ru-RU');
            const d = new Date(queue.date_time * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            const sana = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
            const vaqt = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            await newSendMessage.sendTextUser(
                p.chat_id,
                `✅ To'lov qabul qilindi — navbatingiz tasdiqlandi!\n\n` +
                `💰 Summa: ${summa} so'm\n` +
                `📅 Sana: ${sana}\n` +
                `🕐 Vaqt: ${vaqt}\n` +
                `🔢 Navbat raqami: ${queue.number}\n\n` +
                `Iltimos belgilangan vaqtdan 10 daqiqa oldin keling.`
            );
        }
    }

    // Refund: navbatdan "to'langan" belgisi olinadi
    #unmarkQueuePaid = async (t) => {
        const queue = await QueueModel.findOne({ where: { id: t.queue_id } });
        if (!queue || !(queue.comment || '').includes(PAID_MARK)) return;
        queue.comment = (queue.comment || '').split(PAID_MARK).join('');
        await queue.save();
        const p = await PatientModel.findOne({
            where: { id: queue.patient_id },
            attributes: ['id', 'chat_id']
        });
        if (p && p.chat_id) {
            await newSendMessage.sendTextUser(
                p.chat_id,
                `↩️ To'lovingiz qaytarildi (Payme). Savollar bo'lsa klinikaga murojaat qiling.`
            );
        }
    }
}

module.exports = new PaymeController;
