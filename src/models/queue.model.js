const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');
const PatientModel = require('./patient.model');
const UserModel = require('./user.model');

class QueueModel extends Model {}

QueueModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    room_id: {
        type: DataTypes.INTEGER
    },
    patient_id: {
        type: DataTypes.INTEGER
    },
    number: {
        type: DataTypes.INTEGER
    },
    date_time: {
        type: DataTypes.INTEGER
    },
    status: {
        type: DataTypes.STRING(200)
    },
    user_id: {
        type: DataTypes.INTEGER
    },
    comment: {
        type: DataTypes.STRING(800)
    },
    // 1 = band (bemor bor), 0 = bo'sh joy (oldindan ochilgan slot)
    type: {
        type: DataTypes.TINYINT,
        defaultValue: 1
    },
    reg_id: {
        type: DataTypes.INTEGER
    },
    // 'queue_delete' = navbatdan olib tashlangan (soft delete)
    deleted: {
        type: DataTypes.STRING(50),
        defaultValue: ''
    },
    // Bot orqali olingan navbatda - tanlangan tekshiruv (inspection) IDsi
    ins_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Bot orqali bron qilingan vaqt (unix sekund) - to'lov muddati nazorati uchun
    bot_time: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    show_tablo: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
}, {
    sequelize,
    modelName: 'queue',
    tableName: 'queue',
    timestamps: false
});

QueueModel.belongsTo(PatientModel, { as: 'patient', foreignKey: 'patient_id' });
QueueModel.belongsTo(UserModel, { as: 'user', foreignKey: 'user_id' });

module.exports = QueueModel;
