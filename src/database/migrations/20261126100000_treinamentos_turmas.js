// Treinamentos: catálogo completo, exigências por função, turmas, lista de presença assinada
// pelo crachá (QR + PIN) e registros de capacitação (da turma ou certificados externos).
exports.up = async function(knex) {
  await knex.schema.alterTable('treinamentos', (table) => {
    table.string('nr_referencia', 20);                     // NR-35, NR-10...
    table.text('conteudo_programatico');
    table.boolean('ativo').notNullable().defaultTo(true);
  });

  // Quais treinamentos cada função exige (catálogo da matriz)
  await knex.schema.createTable('funcao_treinamentos', (table) => {
    table.integer('funcao_id').unsigned().notNullable()
      .references('id').inTable('funcoes').onDelete('RESTRICT');
    table.integer('treinamento_id').unsigned().notNullable()
      .references('id').inTable('treinamentos').onDelete('RESTRICT');
    table.primary(['funcao_id', 'treinamento_id']);
  });

  await knex.schema.createTable('turmas', (table) => {
    table.increments('id').primary();
    table.integer('treinamento_id').unsigned().notNullable()
      .references('id').inTable('treinamentos').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.date('data_inicio').notNullable();
    table.date('data_fim').notNullable();
    table.integer('carga_horaria').notNullable();
    table.string('local');
    table.string('instrutor_nome').notNullable();
    table.string('instrutor_qualificacao');                 // ex.: Eng. de Segurança, CREA 12345
    table.string('status', 20).notNullable().defaultTo('aberta'); // aberta, encerrada, cancelada
    table.text('observacao');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.integer('encerrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('encerrado_em');
    table.timestamps(true, true);
    table.index(['filial_id', 'data_inicio']);
  });

  // Assinatura da lista de presença (nunca editada; erro se anula em presenca_anulacoes)
  await knex.schema.createTable('turma_presencas', (table) => {
    table.increments('id').primary();
    table.integer('turma_id').unsigned().notNullable()
      .references('id').inTable('turmas').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable()
      .references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.date('data_presenca').notNullable();
    table.timestamp('assinado_em').notNullable().defaultTo(knex.fn.now());
    table.string('metodo_assinatura', 20).notNullable();     // qr_pin, manual
    table.boolean('pin_validado').notNullable().defaultTo(false);
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.text('observacao');
    table.index(['turma_id']);
  });

  await knex.schema.createTable('presenca_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('presenca_id').unsigned().notNullable().unique()
      .references('id').inTable('turma_presencas').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Registro de capacitação: gerado no encerramento da turma ou lançado como certificado externo
  await knex.schema.alterTable('certificados_treinamentos', (table) => {
    table.integer('turma_id').unsigned().references('id').inTable('turmas').onDelete('RESTRICT');
    table.string('origem', 20).notNullable().defaultTo('legado');   // turma, externo, legado
    table.integer('carga_horaria');
    table.string('instituicao');                                     // onde foi feito (externo)
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('codigo_verificacao', 12).unique();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['turma_id', 'funcionario_id']);
  });

  await knex.schema.createTable('certificado_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('certificado_id').unsigned().notNullable().unique()
      .references('id').inTable('certificados_treinamentos').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('certificado_anulacoes');
  await knex.schema.alterTable('certificados_treinamentos', (table) => {
    table.dropUnique(['turma_id', 'funcionario_id']);
    table.dropForeign('turma_id');
    table.dropForeign('arquivo_id');
    table.dropForeign('registrado_por');
    table.dropColumns('turma_id', 'origem', 'carga_horaria', 'instituicao', 'arquivo_id', 'registrado_por', 'codigo_verificacao', 'created_at');
  });
  await knex.schema.dropTable('presenca_anulacoes');
  await knex.schema.dropTable('turma_presencas');
  await knex.schema.dropTable('turmas');
  await knex.schema.dropTable('funcao_treinamentos');
  await knex.schema.alterTable('treinamentos', (table) => {
    table.dropColumns('nr_referencia', 'conteudo_programatico', 'ativo');
  });
};
