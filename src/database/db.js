const knex = require('knex');
const { types } = require('pg');
const knexfile = require('../../knexfile');

// Colunas DATE voltam como texto 'AAAA-MM-DD' (sem conversão de fuso horário)
types.setTypeParser(1082, (valor) => valor);
// NUMERIC (valores em R$) e BIGINT (somas, ids grandes) como número.
// Os valores do sistema ficam muito abaixo do limite de precisão do JavaScript.
types.setTypeParser(1700, (valor) => Number(valor));
types.setTypeParser(20, (valor) => Number(valor));

const environment = process.env.NODE_ENV || 'development';
const config = knexfile[environment];

const connection = knex(config);

module.exports = connection;
