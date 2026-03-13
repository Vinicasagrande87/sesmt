exports.up = function(knex) {
  return knex.schema.createTable('treinamentos', table => {
    table.increments('id').primary();
    table.string('nome_treinamento').notNullable();
    table.integer('carga_horaria');
    table.integer('validade_meses');
    table.boolean('obrigatorio').defaultTo(true);
  });
};
exports.down = function(knex) { return knex.schema.dropTable('treinamentos'); };