const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class DoctorModel extends Model {}

DoctorModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING(600)
    }
}, {
    sequelize,
    modelName: 'doctor',
    tableName: 'doctor',
    timestamps: false
});

module.exports = DoctorModel;
