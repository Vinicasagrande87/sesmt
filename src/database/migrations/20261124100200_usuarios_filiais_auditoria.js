// Filiais em que cada usuário atua e log de auditoria (quem fez o quê, com antes e depois).
exports.up = async function(knex) {
  await knex.schema.createTable('usuario_filiais', (table) => {
    table.integer('usuario_id').unsigned().notNullable()
      .references('id').inTable('usuarios').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.primary(['usuario_id', 'filial_id']);
  });

  await knex.schema.createTable('auditoria', (table) => {
    table.bigIncrements('id').primary();
    table.integer('usuario_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('acao', 30).notNullable();                   // criar, alterar, inativar...
    table.string('tabela', 60).notNullable();
    table.string('registro_id', 60);
    table.integer('filial_id').unsigned();
    table.jsonb('antes');
    table.jsonb('depois');
    table.string('ip', 64);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['tabela', 'registro_id']);
    table.index(['created_at']);
  });

  // EPI não é apagado, é inativado (catálogo da matriz)
  await knex.schema.alterTable('epis', (table) => {
    table.boolean('ativo').notNullable().defaultTo(true);
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('epis', (table) => {
    table.dropColumn('ativo');
  });
  await knex.schema.dropTable('auditoria');
  await knex.schema.dropTable('usuario_filiais');
};
