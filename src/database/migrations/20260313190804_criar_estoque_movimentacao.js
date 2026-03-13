exports.up = function(knex) {
  return knex.schema.createTable('estoque_movimentacao', table => {
    table.increments('id').primary();
    table.integer('epi_id').unsigned().references('id').inTable('epis').onDelete('CASCADE');
    table.string('tipo'); // Entrada ou Saída
    table.integer('quantidade');
    table.timestamp('data_movimentacao').defaultTo(knex.fn.now());
    table.text('observacao');
  });
};
exports.down = function(knex) { return knex.schema.dropTable('estoque_movimentacao'); };