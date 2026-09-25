const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class InspectionModel extends Model {}

InspectionModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING(600)
    },
    price: {
        type: DataTypes.DECIMAL(20, 2)
    },
    user_id: {
        type: DataTypes.INTEGER
    },
    index_num: {
        type: DataTypes.INTEGER
    },
    // 1 = bot orqali navbat olishga ruxsat berilgan
    bot_navbat: {
        type: DataTypes.BOOLEAN
    }
}, {
    sequelize,
    modelName: 'inspection',
    tableName: 'inspection',
    timestamps: false
});

module.exports = InspectionModel;
