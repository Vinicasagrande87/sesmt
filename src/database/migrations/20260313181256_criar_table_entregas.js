exports.up = function(knex) {
  return knex.schema.createTable('entregas', (table) => {
    table.increments('id').primary();
    
    // Chave Estrangeira para Funcionários
    table.integer('funcionario_id')
      .unsigned()
      .references('id')
      .inTable('funcionarios')
      .onDelete('CASCADE');

    // Chave Estrangeira para EPIs
    table.integer('epi_id')
      .unsigned()
      .references('id')
      .inTable('epis')
      .onDelete('CASCADE');

    table.date('data_entrega').notNullable();
    table.date('data_proxima_troca').notNullable();
    table.string('assinatura_status').defaultTo('Pendente'); // Digital ou física
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('entregas');
};