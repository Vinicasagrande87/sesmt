const knex = require('knex');
const { types } = require('pg');
const knexfile = require('../../knexfile');

// Colunas DATE voltam como texto 'AAAA-MM-DD' (sem conversão de fuso horário)
types.setTypeParser(1082, (valor) => valor);

const environment = process.env.NODE_ENV || 'development';
const config = knexfile[environment];

const connection = knex(config);

module.exports = connection;
