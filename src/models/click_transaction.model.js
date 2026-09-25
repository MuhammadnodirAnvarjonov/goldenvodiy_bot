const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

// Click SHOP API tranzaksiyalari.
// state: 1 = prepare qilingan (kutilmoqda), 2 = to'langan,
//       -1 = bekor qilingan (to'lovgacha), -2 = to'lovdan keyin qaytarilgan
class ClickTransactionModel extends Model {}

ClickTransactionModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    click_trans_id: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    queue_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    amount: {
        type: DataTypes.DECIMAL(20, 2),
        allowNull: false
    },
    state: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1
    },
    reason: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    prepare_time: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    },
    perform_time: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    },
    cancel_time: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
    }
}, {
    sequelize,
    modelName: 'click_transaction',
    tableName: 'click_transaction',
    timestamps: false
});

module.exports = ClickTransactionModel;
