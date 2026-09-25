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

module.exports = {
    getOneByPhone,
    getOneByChatId,
    patientChatIdUpdate,
};
