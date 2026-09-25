const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class InspectorCategoryModel extends Model {}

InspectorCategoryModel.init({
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
    modelName: 'inspection_category',
    tableName: 'inspection_category',
    timestamps: false
});

module.exports = InspectorCategoryModel;
