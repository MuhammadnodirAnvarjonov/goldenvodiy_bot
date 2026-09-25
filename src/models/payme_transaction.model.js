const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

// Payme Merchant API tranzaksiyalari.
// state: 1 = yaratilgan (kutilmoqda), 2 = to'langan,
//        -1 = to'lovdan oldin bekor qilingan, -2 = to'lovdan keyin qaytarilgan
// Barcha *_time maydonlari Payme protokoli bo'yicha MILLISEKUND da.
class PaymeTransactionModel extends Model {}

PaymeTransactionModel.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  // Payme tomonidan beriladigan tranzaksiya IDsi
  paycom_transaction_id: {
    type: DataTypes.STRING(64),
    allowNull: false
  },
  // Payme yuborgan tranzaksiya yaratilish vaqti (ms)
  paycom_time: {
    type: DataTypes.BIGINT,
    allowNull: false
  },
  queue_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  // Summa tiyinda
  amount: {
    type: DataTypes.BIGINT,
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
  create_time: {
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
  modelName: 'payme_transaction',
  tableName: 'payme_transaction',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "id" },
      ]
    },
  ],
});

module.exports = PaymeTransactionModel;
