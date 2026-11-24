// Etapa 6: PPCI por prédio. Projeto aprovado (com as medidas previstas), alvará do Corpo de Bombeiros,
// equipamentos instalados (extintores, hidrantes...) com QR, manutenções e inspeções mensais.
// Nada é apagado: correções por anulação; equipamento retirado é baixado (ativo = false).
exports.up = async function(knex) {
  await knex.schema.createTable('ppcis', (table) => {
    table.increments('id').primary();
    table.integer('predio_id').unsigned().notNullable().references('id').inTable('predios').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('numero_processo', 60);
    table.date('data_aprovacao').notNullable();
    table.string('orgao', 120).notNullable().defaultTo('Corpo de Bombeiros');
    table.string('responsavel_nome', 160);
    table.string('responsavel_registro', 60);                // CREA/CAU
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT');
    table.text('observacao');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['predio_id', 'data_aprovacao']);
  });

  // O que o projeto aprovado prevê (base da comparação com o que está instalado)
  await knex.schema.createTable('ppci_medidas', (table) => {
    table.increments('id').primary();
    table.integer('ppci_id').unsigned().notNullable().references('id').inTable('ppcis').onDelete('RESTRICT');
    table.string('tipo', 40).notNullable();
    table.string('agente', 20);                              // extintor: agua, pqs_abc, co2...
    table.integer('quantidade');                             // null = medida não contável (saída, brigada...)
    table.text('especificacao');
  });

  await knex.schema.createTable('ppci_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('ppci_id').unsigned().notNullable().unique().references('id').inTable('ppcis').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('alvaras', (table) => {
    table.increments('id').primary();
    table.integer('predio_id').unsigned().notNullable().references('id').inTable('predios').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('ppci_id').unsigned().references('id').inTable('ppcis').onDelete('RESTRICT');
    table.string('tipo_documento', 40).notNullable().defaultTo('Alvará');  // APPCI, AVCB, CLCB, provisório...
    table.string('numero', 60);
    table.date('data_emissao').notNullable();
    table.date('data_validade').notNullable();
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT');
    table.text('observacao');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['predio_id', 'data_validade']);
  });

  await knex.schema.createTable('alvara_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('alvara_id').unsigned().notNullable().unique().references('id').inTable('alvaras').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('equipamentos_incendio', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('predio_id').unsigned().notNullable().references('id').inTable('predios').onDelete('RESTRICT');
    table.string('tipo', 40).notNullable();
    table.string('identificacao', 40).notNullable();         // número pintado/plaqueta: EXT-011
    table.string('localizacao').notNullable();               // "2º andar, ao lado do elevador"
    table.string('agente', 20);
    table.string('capacidade', 20);                          // 4 kg, 10 L, 6 kg...
    table.string('fabricante', 80);
    table.string('numero_serie', 60);
    table.integer('ano_fabricacao');
    table.uuid('qr_token').notNullable().unique();
    table.boolean('ativo').notNullable().defaultTo(true);
    table.text('motivo_baixa');
    table.timestamps(true, true);
    table.unique(['filial_id', 'identificacao']);
  });

  // Recarga (nível 2), teste hidrostático (nível 3) e manutenção geral (mangueiras, iluminação...)
  await knex.schema.createTable('equipamento_manutencoes', (table) => {
    table.increments('id').primary();
    table.integer('equipamento_id').unsigned().notNullable().references('id').inTable('equipamentos_incendio').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('tipo', 30).notNullable();
    table.date('data_servico').notNullable();
    table.date('data_proxima').notNullable();
    table.string('empresa', 160);
    table.string('numero_selo', 60);                         // selo do Inmetro / nº do certificado
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.text('observacao');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['equipamento_id', 'tipo', 'data_servico']);
  });

  await knex.schema.createTable('manutencao_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('manutencao_id').unsigned().notNullable().unique().references('id').inTable('equipamento_manutencoes').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Inspeção mensal: lida pelo QR colado no equipamento (prova de que o inspetor esteve lá)
  await knex.schema.createTable('equipamento_inspecoes', (table) => {
    table.increments('id').primary();
    table.integer('equipamento_id').unsigned().notNullable().references('id').inTable('equipamentos_incendio').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('predio_id').unsigned().notNullable().references('id').inTable('predios').onDelete('RESTRICT');
    table.string('localizacao').notNullable();               // onde estava no dia da inspeção
    table.timestamp('data_hora').notNullable().defaultTo(knex.fn.now());
    table.string('metodo', 10).notNullable();                // qr | manual
    table.jsonb('itens').notNullable();                      // { lacre_intacto: true, sinalizacao: false, ... } (null = não se aplica)
    table.boolean('conforme').notNullable();
    table.text('observacao');
    table.uuid('foto_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.string('codigo_verificacao', 8).notNullable().unique();
    table.index(['equipamento_id', 'data_hora']);
  });

  await knex.schema.createTable('inspecao_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('inspecao_id').unsigned().notNullable().unique().references('id').inTable('equipamento_inspecoes').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  for (const t of ['inspecao_anulacoes', 'equipamento_inspecoes', 'manutencao_anulacoes', 'equipamento_manutencoes',
    'equipamentos_incendio', 'alvara_anulacoes', 'alvaras', 'ppci_anulacoes', 'ppci_medidas', 'ppcis']) {
    await knex.schema.dropTable(t);
  }
};
