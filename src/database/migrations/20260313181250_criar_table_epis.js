exports.up = function(knex) {
  return knex.schema.createTable('epis', (table) => {
    table.increments('id').primary();
    table.string('nome').notNullable();
    table.string('ca').notNullable(); // Certificado de Aprovação
    table.string('fabricante');
    table.integer('validade_dias').notNullable(); // Dias de validade do EPI
    table.text('descricao');
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('epis');
};