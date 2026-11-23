// Catálogo de EPIs da matriz: categoria, unidade, tamanhos (itens de estoque) e histórico de CAs.
exports.up = async function(knex) {
  await knex.schema.alterTable('epis', (table) => {
    table.string('categoria', 60);                                   // Proteção das mãos, auditiva...
    table.string('unidade', 20).notNullable().defaultTo('unidade');  // unidade, par, caixa...
    table.string('ca').nullable().alter();                           // CA agora fica em epi_cas
  });

  // Cada tamanho é um item com saldo próprio (luva M e luva G não se misturam)
  await knex.schema.createTable('epi_itens', (table) => {
    table.increments('id').primary();
    table.integer('epi_id').unsigned().notNullable()
      .references('id').inTable('epis').onDelete('RESTRICT');
    table.string('tamanho', 20).notNullable().defaultTo('Único');
    table.string('codigo', 40);                                     // código interno / de barras
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamps(true, true);
    table.unique(['epi_id', 'tamanho']);
  });

  // O CA vence e é renovado: guardamos todos, a entrega copia o vigente
  await knex.schema.createTable('epi_cas', (table) => {
    table.increments('id').primary();
    table.integer('epi_id').unsigned().notNullable()
      .references('id').inTable('epis').onDelete('RESTRICT');
    table.string('numero', 20).notNullable();
    table.date('validade');                                         // null = validade não informada (bloqueia entrega)
    table.integer('cadastrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['epi_id', 'numero', 'validade']);
  });

  // EPIs já cadastrados: um item "Único" e o CA antigo (sem validade conhecida)
  const epis = await knex('epis').select('id', 'ca');
  for (const epi of epis) {
    await knex('epi_itens').insert({ epi_id: epi.id, tamanho: 'Único' });
    if (epi.ca) await knex('epi_cas').insert({ epi_id: epi.id, numero: epi.ca });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTable('epi_cas');
  await knex.schema.dropTable('epi_itens');
  await knex('epis').whereNull('ca').update({ ca: '' });
  await knex.schema.alterTable('epis', (table) => {
    table.dropColumn('categoria');
    table.dropColumn('unidade');
    table.string('ca').notNullable().alter();
  });
};
