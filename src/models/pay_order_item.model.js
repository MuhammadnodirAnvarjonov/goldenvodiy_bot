const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

// To'lov buyurtmasi ichidagi hizmatlar (narx buyurtma paytidagi holatda saqlanadi)
class PayOrderItemModel extends Model {}

PayOrderItemModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    order_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    inspection_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING(600),
        allowNull: false
    },
    price: {
        type: DataTypes.DECIMAL(20, 2),
        defaultValue: 0
    }
}, {
    sequelize,
    modelName: 'pay_order_item',
    tableName: 'pay_order_item',
    timestamps: false
});

module.exports = PayOrderItemModel;
