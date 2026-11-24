// Empresas terceirizadas (NR-1, 1.5.8): empresa contratada (única no grupo, pelo CNPJ), contratos por filial,
// trabalhadores alocados e documentos (PGR/PCMSO da empresa; ASO, integração e treinamentos do trabalhador).
// Documentos só aceitam inclusão (corrige-se por anulação). A permissão de trabalho passa a aceitar terceirizados.
exports.up = async function(knex) {
  await knex.schema.createTable('empresas_terceiras', (table) => {
    table.increments('id').primary();
    table.string('razao_social').notNullable();
    table.string('nome_fantasia');
    table.string('cnpj', 14).notNullable().unique();
    table.string('contato_nome');
    table.string('contato_email');
    table.string('contato_telefone', 30);
    table.boolean('ativa').notNullable().defaultTo(true);
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('terceiro_contratos', (table) => {
    table.increments('id').primary();
    table.integer('empresa_id').unsigned().notNullable().references('id').inTable('empresas_terceiras').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('numero', 40);
    table.text('objeto').notNullable();                        // serviço contratado
    table.date('inicio').notNullable();
    table.date('fim');
    table.integer('responsavel_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT'); // fiscal do contrato
    table.string('responsavel_nome');
    table.jsonb('treinamentos_exigidos').notNullable().defaultTo('[]'); // ids do catálogo exigidos de quem trabalha neste contrato
    table.timestamp('encerrado_em');
    table.text('motivo_encerramento');
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
    table.index(['filial_id']);
  });

  await knex.schema.createTable('terceiro_trabalhadores', (table) => {
    table.increments('id').primary();
    table.integer('empresa_id').unsigned().notNullable().references('id').inTable('empresas_terceiras').onDelete('RESTRICT');
    table.string('nome').notNullable();
    table.string('cpf', 11).notNullable().unique();
    table.string('funcao');
    table.boolean('ativo').notNullable().defaultTo(true);
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('terceiro_alocacoes', (table) => {
    table.increments('id').primary();
    table.integer('contrato_id').unsigned().notNullable().references('id').inTable('terceiro_contratos').onDelete('RESTRICT');
    table.integer('trabalhador_id').unsigned().notNullable().references('id').inTable('terceiro_trabalhadores').onDelete('RESTRICT');
    table.date('inicio').notNullable();
    table.date('fim');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['contrato_id']);
    table.index(['trabalhador_id']);
  });

  await knex.schema.createTable('terceiro_documentos', (table) => {
    table.increments('id').primary();
    table.integer('empresa_id').unsigned().notNullable().references('id').inTable('empresas_terceiras').onDelete('RESTRICT');
    table.integer('trabalhador_id').unsigned().references('id').inTable('terceiro_trabalhadores').onDelete('RESTRICT'); // null = da empresa
    table.string('tipo', 15).notNullable();                    // pgr, pcmso, aso, integracao, treinamento, outro
    table.string('descricao');
    table.integer('treinamento_id').unsigned().references('id').inTable('treinamentos').onDelete('RESTRICT');
    table.string('nr_referencia', 20);
    table.string('resultado', 20);                             // ASO: apto, apto_restricao, inapto (sem dados médicos)
    table.date('data_documento').notNullable();
    table.date('data_vencimento');
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT');
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['empresa_id']);
    table.index(['trabalhador_id']);
  });
  await knex.schema.createTable('terceiro_documento_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('documento_id').unsigned().notNullable().unique().references('id').inTable('terceiro_documentos').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  for (const t of ['terceiro_documentos', 'terceiro_documento_anulacoes']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }

  // Permissão de trabalho: participante pode ser funcionário ou trabalhador terceirizado (um dos dois)
  await knex.schema.alterTable('pt_participantes', (table) => {
    table.integer('funcionario_id').unsigned().nullable().alter();
    table.integer('terceiro_trabalhador_id').unsigned().references('id').inTable('terceiro_trabalhadores').onDelete('RESTRICT');
    table.unique(['pt_id', 'terceiro_trabalhador_id']);
  });
  await knex.raw('alter table pt_participantes add constraint pt_participantes_um_participante check (num_nonnulls(funcionario_id, terceiro_trabalhador_id) = 1)');
};

exports.down = async function(knex) {
  await knex.raw('alter table pt_participantes drop constraint if exists pt_participantes_um_participante');
  await knex.raw('alter table pt_participantes disable trigger pt_participantes_somente_inclusao');
  await knex('pt_participantes').whereNotNull('terceiro_trabalhador_id').del();
  await knex.raw('alter table pt_participantes enable trigger pt_participantes_somente_inclusao');
  await knex.schema.alterTable('pt_participantes', (table) => {
    table.dropUnique(['pt_id', 'terceiro_trabalhador_id']);
    table.dropForeign('terceiro_trabalhador_id');
    table.dropColumn('terceiro_trabalhador_id');
    table.integer('funcionario_id').unsigned().notNullable().alter();
  });
  for (const t of ['terceiro_documento_anulacoes', 'terceiro_documentos', 'terceiro_alocacoes', 'terceiro_trabalhadores', 'terceiro_contratos', 'empresas_terceiras']) {
    await knex.schema.dropTable(t);
  }
};
