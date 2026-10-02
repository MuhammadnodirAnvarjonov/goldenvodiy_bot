// Bemor bilan ishlash - bot uchun kerakli minimal funksiyalar
// (backend patientController dan ko'chirilgan qismi)
const PatientModel = require('../models/patient.model');

const getOneByPhone = async (phone) => {
    return await PatientModel.findOne({
        where: { phone: phone }
    });
};

const getOneByChatId = async (chat_id) => {
    return await PatientModel.findOne({
        where: { chat_id: chat_id }
    });
};

const patientChatIdUpdate = async (id, chat_id) => {
    try {
        await PatientModel.update({ chat_id: chat_id }, { where: { id: id } });
        return true;
    } catch (error) {
        console.log('patient_chat_id_update', error);
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
const createPatient = async ({ fullname, phone, birthday, gender, chat_id }) => {
    // Shu vaqt ichida boshqa joydan qo'shilgan bo'lsa - takror yaratmaymiz
    const existing = await PatientModel.findOne({ where: { phone } });
    if (existing) {
        await PatientModel.update({ chat_id }, { where: { id: existing.id } });
        return existing;
    }
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
    getOneByPhone,
    getOneByChatId,
    patientChatIdUpdate,
    normalizePhone,
    createPatient,
};
