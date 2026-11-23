const crypto = require('crypto');

// Adiciona a chave aleatória do crachá (qr_token) aos funcionários.
// O QR code carrega só essa chave: nunca o CPF nem o id.
exports.up = async function(knex) {
  // 1) Cria a coluna aceitando nulo, para não quebrar os registros que já existem
  await knex.schema.alterTable('funcionarios', (table) => {
    table.string('qr_token', 36).nullable();
  });

  // 2) Gera uma chave para cada funcionário já cadastrado
  const existentes = await knex('funcionarios').whereNull('qr_token').select('id');
  for (const { id } of existentes) {
    await knex('funcionarios').where({ id }).update({ qr_token: crypto.randomUUID() });
  }

  // 3) Agora que todos têm chave: obrigatória e única
  await knex.schema.alterTable('funcionarios', (table) => {
    table.string('qr_token', 36).notNullable().alter();
    table.unique(['qr_token']);
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropUnique(['qr_token']);
  });
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropColumn('qr_token');
  });
};
