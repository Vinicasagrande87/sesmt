exports.up = function(knex) {
  return knex.schema.createTable('acidentes_trabalho', table => {
    table.increments('id').primary();
    table.integer('funcionario_id').unsigned().references('id').inTable('funcionarios').onDelete('CASCADE');
    table.timestamp('data_hora_acidente').defaultTo(knex.fn.now());
    table.string('local_acidente').notNullable();
    table.text('descricao_ocorrencia');
    table.string('parte_corpo_atingida');
    table.boolean('houve_afastamento').defaultTo(false);
    table.integer('dias_afastado');
    table.boolean('cat_emitida').defaultTo(false);
  });
};
exports.down = function(knex) { return knex.schema.dropTable('acidentes_trabalho'); };