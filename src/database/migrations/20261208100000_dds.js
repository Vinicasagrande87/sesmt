// DDS (diálogo diário de segurança): banco de temas, registro do DDS por filial/setor, presença pelo crachá
// (QR + PIN, ou manual pela gestão), encerramento com resumo e metas de frequência por setor.
// Presenças e anulações só aceitam inclusão.
exports.up = async function(knex) {
  await knex.schema.createTable('dds_temas', (table) => {
    table.increments('id').primary();
    table.string('titulo', 200).notNullable().unique();
    table.text('conteudo');                                   // roteiro de apoio para quem conduz
    table.string('nr_referencia', 20);
    table.boolean('ativo').notNullable().defaultTo(true);
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('dds', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('ano').notNullable();
    table.integer('sequencial').notNullable();
    table.date('data').notNullable();
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT'); // null = filial inteira
    table.string('local', 200);
    table.integer('tema_id').unsigned().references('id').inTable('dds_temas').onDelete('RESTRICT');
    table.string('tema', 200).notNullable();                  // título na data (o catálogo pode mudar)
    table.text('resumo');                                     // o que foi falado (obrigatório para encerrar)
    table.integer('duracao_min');
    table.integer('condutor_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('condutor_nome', 200);
    table.string('status', 12).notNullable().defaultTo('aberto'); // aberto, encerrado, cancelado
    table.timestamp('encerrado_em');
    table.text('motivo_cancelamento');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
    table.unique(['filial_id', 'ano', 'sequencial']);
    table.index(['filial_id', 'data']);
  });

  await knex.schema.createTable('dds_presencas', (table) => {
    table.increments('id').primary();
    table.integer('dds_id').unsigned().notNullable().references('id').inTable('dds').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT'); // da época
    table.timestamp('assinado_em').notNullable().defaultTo(knex.fn.now());
    table.string('metodo', 10).notNullable();                 // qr_pin, manual
    table.boolean('pin_validado').notNullable();
    table.text('observacao');
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.unique(['dds_id', 'funcionario_id']);
  });
  await knex.schema.createTable('dds_presenca_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('presenca_id').unsigned().notNullable().unique().references('id').inTable('dds_presencas').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Meta de frequência: por setor, ou da filial inteira (setor_id null)
  await knex.schema.createTable('dds_metas', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.string('frequencia', 12).notNullable();             // diaria, semanal, quinzenal, mensal
    table.boolean('ativa').notNullable().defaultTo(true);
    table.integer('definido_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });
  await knex.raw('create unique index dds_metas_filial_setor_unique on dds_metas (filial_id, coalesce(setor_id, 0))');

  for (const t of ['dds_presencas', 'dds_presenca_anulacoes']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }
};

exports.down = async function(knex) {
  for (const t of ['dds_metas', 'dds_presenca_anulacoes', 'dds_presencas', 'dds', 'dds_temas']) await knex.schema.dropTable(t);
};
