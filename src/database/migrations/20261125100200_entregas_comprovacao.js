// Comprovação da entrega: arquivos (fotos, termos), PIN e termo de adesão do funcionário,
// dados completos na entrega (CA copiado, motivo, técnico, IP, aparelho, código) e estornos.
exports.up = async function(knex) {
  // Arquivos guardados no próprio banco por enquanto (dá para trocar por um storage depois)
  await knex.schema.createTable('arquivos', (table) => {
    table.uuid('id').primary();
    table.string('nome').notNullable();
    table.string('tipo_mime', 60).notNullable();
    table.integer('tamanho').notNullable();
    table.string('sha256', 64).notNullable();                    // prova de que o arquivo não foi trocado
    table.string('contexto', 30).notNullable();                  // foto_entrega, termo_adesao...
    table.integer('filial_id').unsigned().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.string('armazenamento', 20).notNullable().defaultTo('banco');
    table.binary('conteudo');
    table.integer('enviado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('funcionarios', (table) => {
    table.string('pin_hash', 60);
    table.timestamp('pin_definido_em');
    table.integer('pin_falhas').notNullable().defaultTo(0);
    table.timestamp('pin_bloqueado_ate');
    table.date('termo_adesao_data');
    table.uuid('termo_adesao_arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
  });

  await knex.schema.alterTable('entregas', (table) => {
    table.integer('item_id').unsigned().references('id').inTable('epi_itens').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.integer('quantidade').notNullable().defaultTo(1);
    table.string('motivo', 30);
    table.string('ca_numero', 20);
    table.date('ca_validade');
    table.timestamp('data_hora');                                  // hora do servidor, não do celular
    table.integer('usuario_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('metodo_assinatura', 20);                         // qr_pin, manual
    table.boolean('pin_validado');
    table.boolean('termo_adesao_vigente');
    table.uuid('foto_arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.string('codigo_verificacao', 12).unique();
    table.decimal('custo_total', 14, 2);
    table.text('observacao');
  });

  // Itens das entregas antigas: o item "Único" do EPI
  await knex.raw(`
    update entregas e set item_id = i.id
    from epi_itens i
    where i.epi_id = e.epi_id and i.tamanho = 'Único' and e.item_id is null
  `);

  // A entrega nunca é editada: o estorno é um registro separado
  await knex.schema.createTable('entrega_estornos', (table) => {
    table.increments('id').primary();
    table.integer('entrega_id').unsigned().notNullable().unique()
      .references('id').inTable('entregas').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('entrega_estornos');
  await knex.schema.alterTable('entregas', (table) => {
    for (const fk of ['item_id', 'filial_id', 'setor_id', 'funcao_id', 'usuario_id', 'foto_arquivo_id']) table.dropForeign(fk);
    table.dropColumns('item_id', 'filial_id', 'setor_id', 'funcao_id', 'quantidade', 'motivo', 'ca_numero',
      'ca_validade', 'data_hora', 'usuario_id', 'metodo_assinatura', 'pin_validado', 'termo_adesao_vigente',
      'foto_arquivo_id', 'ip', 'user_agent', 'codigo_verificacao', 'custo_total', 'observacao');
  });
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropForeign('termo_adesao_arquivo_id');
    table.dropColumns('pin_hash', 'pin_definido_em', 'pin_falhas', 'pin_bloqueado_ate',
      'termo_adesao_data', 'termo_adesao_arquivo_id');
  });
  await knex.schema.dropTable('arquivos');
};
