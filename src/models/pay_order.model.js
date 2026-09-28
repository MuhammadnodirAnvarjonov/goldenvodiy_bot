const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');
const PayOrderItemModel = require('./pay_order_item.model');

// To'lov buyurtmasi: bitta navbat (tashrif) uchun bir nechta hizmatni qamrab oladi.
// Payme/Click "account" maydoni = shu jadvalning id si.
// status: pending -> paid -> (canceled)
class PayOrderModel extends Model {}

PayOrderModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    patient_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    queue_id: {
        type: DataTypes.INTEGER
    },
    reg_id: {
        type: DataTypes.INTEGER
    },
    total_summa: {
        type: DataTypes.DECIMAL(20, 2),
        defaultValue: 0
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'pending'
    },
    pay_type: {
        type: DataTypes.STRING(20)
    },
    created_at: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    paid_time: {
        type: DataTypes.BIGINT,
        defaultValue: 0
    }
}, {
    sequelize,
    modelName: 'pay_order',
    tableName: 'pay_order',
    timestamps: false
});

PayOrderModel.hasMany(PayOrderItemModel, { as: 'items', foreignKey: 'order_id' });

module.exports = PayOrderModel;
