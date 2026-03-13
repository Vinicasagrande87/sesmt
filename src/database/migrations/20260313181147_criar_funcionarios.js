exports.up = function(knex) {
  return knex.schema.createTable('funcionarios', (table) => {
    table.increments('id').primary();
    table.string('matricula').unique().notNullable();
    table.string('nome').notNullable();
    table.string('cpf', 11).unique().notNullable();
    table.date('data_nascimento').notNullable();
    table.string('cargo').notNullable();
    table.string('setor').notNullable();
    table.date('data_admissao').notNullable();
    table.string('status').defaultTo('Ativo');
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('funcionarios');
};