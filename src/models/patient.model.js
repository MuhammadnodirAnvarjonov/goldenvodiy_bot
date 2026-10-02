// Klinika bazasidagi `patient` jadvalining bot uchun kerakli qismi.
// Jadval klinika dasturi tomonidan yaratiladi - bu yerda faqat o'qiladi/chat_id yangilanadi.
const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class PatientModel extends Model {}

PatientModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    fullname: {
        type: DataTypes.STRING(300)
    },
    name: {
        type: DataTypes.STRING(300)
    },
    lastname: {
        type: DataTypes.STRING(300)
    },
    patronymic: {
        type: DataTypes.STRING(400)
    },
    phone: {
        type: DataTypes.STRING(20)
    },
    gender: {
        type: DataTypes.STRING(10)
    },
    birthday: {
        type: DataTypes.STRING
    },
    imtiyoz_type: {
        type: DataTypes.STRING
    },
    citizen: {
        type: DataTypes.BOOLEAN
    },
    region_id: {
        type: DataTypes.INTEGER
    },
    district_id: {
        type: DataTypes.INTEGER
    },
    chat_id: {
        type: DataTypes.BIGINT
    }
}, {
    sequelize,
    modelName: 'patient',
    tableName: 'patient',
    timestamps: false
});

module.exports = PatientModel;
