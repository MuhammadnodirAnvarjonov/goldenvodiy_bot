const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');
const DoctorModel = require('./doctor.model');
const InspectorCategoryModel = require('./inspector_category.model');

class UserModel extends Model {
    toJSON() {
        var values = Object.assign({}, this.get());
        delete values.password_hash;
        return values;
    }
}

UserModel.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
    },
    user_name: {
        type: DataTypes.STRING(600)
    },
    doctor_id: {
        type: DataTypes.INTEGER
    },
    inspection_category_id: {
        type: DataTypes.INTEGER
    }
}, {
    sequelize,
    modelName: 'user',
    tableName: 'user',
    timestamps: false
});

UserModel.belongsTo(DoctorModel, { as: 'doctor', foreignKey: 'doctor_id' });
UserModel.belongsTo(InspectorCategoryModel, { as: 'inspecton', foreignKey: 'inspection_category_id' });

module.exports = UserModel;
