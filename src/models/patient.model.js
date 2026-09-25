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
        type: DataTypes.STRING(600)
    },
    phone: {
        type: DataTypes.STRING(100)
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
