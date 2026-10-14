// Bemor bilan ishlash - bot uchun kerakli minimal funksiyalar
// (backend patientController dan ko'chirilgan qismi)
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const PatientModel = require('../models/patient.model');

// Bitta raqamga ro'yxatdan o'tgan barcha bemorlar (oila a'zolari bitta raqam bilan).
// Bazada raqam turli formatda bo'lishi mumkin: "901234567", "998901234567",
// "+998 90 123 45 67" — faqat raqamlar solishtiriladi.
const findAllByPhone = async (phone) => {
    // "998901234567" va "901234567" bir xil raqam — avval 9 xonaga keltiramiz
    const digits = normalizePhone(phone);
    if (!digits) return [];
    const variants = digits.length === 9 ? [digits, '998' + digits] : [digits];
    return await PatientModel.findAll({
        where: sqlWhere(fn('REGEXP_REPLACE', col('phone'), '[^0-9]', ''), { [Op.in]: variants }),
        attributes: ['id', 'fullname', 'name', 'lastname', 'patronymic', 'birthday', 'phone', 'chat_id'],
        order: [['id', 'ASC']],
        limit: 20
    });
};

const getOneByPhone = async (phone) => {
    const list = await findAllByPhone(phone);
    return list[0] || null;
};

// Bitta chatga bitta "faol" bemor bog'lanadi (tanlangan). Eski bog'lanishlar bo'lsa
// eng oxirgi bog'langani olinadi.
const getOneByChatId = async (chat_id) => {
    return await PatientModel.findOne({
        where: { chat_id: chat_id },
        order: [['id', 'DESC']]
    });
};

// Chatni tanlangan bemorga bog'laydi: shu chatga bog'langan boshqa bemorlardan
// bog'lanish olinadi (botda kim nomidan ish ko'rilayotgani aniq bo'lsin)
const linkChat = async (patientId, chat_id) => {
    await PatientModel.update(
        { chat_id: null },
        { where: { chat_id: chat_id, id: { [Op.ne]: patientId } } }
    );
    await PatientModel.update({ chat_id: chat_id }, { where: { id: patientId } });
};

// Bemorning ko'rinadigan ismi (fullname bo'sh bo'lsa familiya/ism/sharifdan)
const displayName = (p) => {
    const full = String((p && p.fullname) || '').trim();
    if (full) return full;
    return [p && p.lastname, p && p.name, p && p.patronymic].filter(Boolean).join(' ').trim() || `Bemor #${p && p.id}`;
};

const patientChatIdUpdate = async (id, chat_id) => {
    try {
        await PatientModel.update({ chat_id: chat_id }, { where: { id: id } });
        return true;
    } catch (error) {
        console.error('patient_chat_id_update xato:', error.message);
        return false;
    }
};

// Telegram kontaktidagi raqamni bazadagi formatga keltiradi: 9 raqam, 998 siz
const normalizePhone = (raw) => {
    let phone = String(raw || '').replace(/[^\d]/g, '');
    if (phone.length === 12 && phone.startsWith('998')) phone = phone.slice(3);
    return phone;
};

// Bot orqali o'zini ro'yxatdan o'tkazgan bemorni yaratish.
// Maydonlar desktop (patientController.create) formati bilan bir xil:
// gender 'Erkak'/'Ayol', birthday - kun boshining unix soniyasi (matn),
// imtiyoz_type 'Imtiyozsiz', citizen 0, viloyat desktop standarti (2).
// forceNew = true: shu raqamda boshqa bemorlar bo'lsa ham YANGI bemor yaratiladi
// (oila a'zosi o'zini ro'yxatda topmagan holat)
const createPatient = async ({ fullname, phone, birthday, gender, chat_id, forceNew = false }) => {
    // Shu vaqt ichida boshqa joydan qo'shilgan bo'lsa - takror yaratmaymiz
    if (!forceNew) {
        const existing = await getOneByPhone(phone);
        if (existing) {
            await linkChat(existing.id, chat_id);
            return existing;
        }
    }
    // Shu chatga bog'langan boshqa bemorlardan bog'lanish olinadi (yangi bemor faol bo'ladi)
    await PatientModel.update({ chat_id: null }, { where: { chat_id } });
    return await PatientModel.create({
        fullname,
        name: '',
        lastname: '',
        patronymic: '',
        phone,
        gender,
        birthday: String(birthday),
        imtiyoz_type: 'Imtiyozsiz',
        citizen: 0,
        region_id: 2,
        district_id: null,
        chat_id
    });
};

module.exports = {
    findAllByPhone,
    linkChat,
    displayName,
    getOneByPhone,
    getOneByChatId,
    patientChatIdUpdate,
    normalizePhone,
    createPatient,
};
