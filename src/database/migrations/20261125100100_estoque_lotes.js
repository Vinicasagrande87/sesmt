// Estoque por filial em lotes (cada compra com o preço pago) e movimentações imutáveis.
// O saldo é sempre a soma das movimentações; erro se corrige com estorno, nunca editando.
exports.up = async function(knex) {
  await knex.schema.createTable('fornecedores', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('nome').notNullable();
    table.string('cnpj', 14);
    table.string('contato');
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamps(true, true);
    table.unique(['filial_id', 'nome']);
  });

  await knex.schema.createTable('estoque_minimo', (table) => {
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('item_id').unsigned().notNullable()
      .references('id').inTable('epi_itens').onDelete('RESTRICT');
    table.integer('minimo').notNullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['filial_id', 'item_id']);
  });

  await knex.schema.createTable('lotes', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('item_id').unsigned().notNullable()
      .references('id').inTable('epi_itens').onDelete('RESTRICT');
    table.integer('fornecedor_id').unsigned().references('id').inTable('fornecedores').onDelete('RESTRICT');
    table.string('nota_numero', 30);
    table.date('nota_data');
    table.date('data_entrada').notNullable();
    table.integer('quantidade_inicial').notNullable();
    table.decimal('valor_unitario', 12, 4).notNullable();       // preço pago nesta compra
    table.date('data_fabricacao');
    table.date('data_validade');
    table.string('lote_fabricante', 40);
    table.integer('origem_lote_id').unsigned().references('id').inTable('lotes').onDelete('RESTRICT'); // transferência
    table.text('observacao');
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['filial_id', 'item_id', 'data_entrada']);
  });

  await knex.schema.createTable('transferencias', (table) => {
    table.increments('id').primary();
    table.integer('origem_filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('destino_filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('item_id').unsigned().notNullable()
      .references('id').inTable('epi_itens').onDelete('RESTRICT');
    table.integer('quantidade').notNullable();
    table.string('status', 20).notNullable().defaultTo('pendente'); // pendente, recebida, cancelada
    table.text('observacao');
    table.integer('enviado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('enviado_em').notNullable().defaultTo(knex.fn.now());
    table.integer('concluido_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('concluido_em');
  });

  await knex.schema.createTable('movimentacoes', (table) => {
    table.bigIncrements('id').primary();
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('item_id').unsigned().notNullable()
      .references('id').inTable('epi_itens').onDelete('RESTRICT');
    table.integer('lote_id').unsigned().notNullable()
      .references('id').inTable('lotes').onDelete('RESTRICT');
    // entrada, entrega, descarte, ajuste, transferencia_saida, transferencia_entrada, estorno
    table.string('tipo', 30).notNullable();
    table.integer('quantidade').notNullable();                   // + entra no lote, - sai do lote
    table.decimal('valor_unitario', 12, 4).notNullable();        // custo do lote (congelado)
    table.decimal('valor_total', 14, 2).notNullable();           // quantidade x valor_unitario
    table.integer('entrega_id').unsigned().references('id').inTable('entregas').onDelete('RESTRICT');
    table.integer('transferencia_id').unsigned().references('id').inTable('transferencias').onDelete('RESTRICT');
    table.bigInteger('estorno_de_id').unsigned().references('id').inTable('movimentacoes').onDelete('RESTRICT');
    table.text('motivo');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['filial_id', 'item_id']);
    table.index(['lote_id']);
    table.index(['created_at']);
    table.unique(['estorno_de_id']);                              // cada movimento só pode ser estornado uma vez
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('movimentacoes');
  await knex.schema.dropTable('transferencias');
  await knex.schema.dropTable('lotes');
  await knex.schema.dropTable('estoque_minimo');
  await knex.schema.dropTable('fornecedores');
};
