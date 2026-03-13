exports.up = function(knex) {
  return knex.schema.createTable('certificados_treinamentos', table => {
    table.increments('id').primary();
    table.integer('funcionario_id').unsigned().references('id').inTable('funcionarios').onDelete('CASCADE');
    table.integer('treinamento_id').unsigned().references('id').inTable('treinamentos').onDelete('CASCADE');
    table.date('data_realizacao');
    table.date('data_vencimento');
    table.string('instrutor');
    table.string('status');
  });
};
exports.down = function(knex) { return knex.schema.dropTable('certificados_treinamentos'); };