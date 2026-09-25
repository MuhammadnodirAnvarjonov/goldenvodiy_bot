const { Sequelize } = require('sequelize');
const config = require('./config');

const logging = config.node_env === 'production' ? false : console.log;

const db_sequelize = new Sequelize(
    config.db_name,
    config.db_user,
    config.db_pass,
    {
        host: config.db_host,
        port: config.db_port,
        dialect: 'mysql',
        dialectOptions: {
            decimalNumbers: true
        },
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        },
        logging,
    },
);

module.exports = db_sequelize;
