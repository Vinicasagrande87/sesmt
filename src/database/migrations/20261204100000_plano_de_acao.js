// Plano de ação central (NR-1, 1.5.5.2: medidas de prevenção com cronograma, responsáveis e acompanhamento).
// Cada ação nasce de uma origem (ocorrência, PGR, inspeção, prédio ou manual), tem responsável e prazo,
// e segue o ciclo: aberta -> em andamento -> concluída (com evidência) -> verificada (eficácia).
// A linha do tempo (acao_registros) e as reprogramações de prazo (acao_prazos) só aceitam inclusão.
exports.up = async function(knex) {
  await knex.schema.createTable('acoes', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('ano').notNullable();
    table.integer('sequencial').notNullable();
    table.string('titulo', 200).notNullable();                 // o quê
    table.text('descricao');                                   // como
    table.string('origem_tipo', 20).notNullable();             // ocorrencia, pgr, inspecao_incendio, predio, manual
    table.integer('origem_id');
    table.string('origem_descricao', 300);                     // como era a origem quando a ação foi aberta
    table.string('tipo_medida', 20);                           // eliminacao, substituicao, engenharia, administrativa, epi
    table.string('prioridade', 10).notNullable().defaultTo('media'); // baixa, media, alta, urgente
    table.integer('responsavel_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('responsavel_nome', 200);                     // quem não tem login (ex.: empresa contratada)
    table.date('prazo_original').notNullable();
    table.date('prazo').notNullable();                         // atual (reprogramações em acao_prazos)
    table.string('status', 15).notNullable().defaultTo('aberta'); // aberta, em_andamento, concluida, verificada, cancelada
    table.decimal('custo_estimado', 14, 2);
    table.decimal('custo_real', 14, 2);
    table.timestamp('concluida_em');
    table.integer('concluida_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('verificada_em');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
    table.unique(['filial_id', 'ano', 'sequencial']);
    table.index(['filial_id', 'status', 'prazo']);
    table.index(['origem_tipo', 'origem_id']);
    table.index(['responsavel_id']);
  });

  // Linha do tempo: andamento, conclusão, verificação, reabertura, cancelamento, mudança de responsável
  await knex.schema.createTable('acao_registros', (table) => {
    table.increments('id').primary();
    table.integer('acao_id').unsigned().notNullable().references('id').inTable('acoes').onDelete('RESTRICT');
    table.string('tipo', 20).notNullable();
    table.text('texto').notNullable();
    table.string('status_novo', 15);                           // quando o registro muda o status
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT'); // evidência (foto, nota, laudo)
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['acao_id', 'created_at']);
  });

  await knex.schema.createTable('acao_prazos', (table) => {
    table.increments('id').primary();
    table.integer('acao_id').unsigned().notNullable().references('id').inTable('acoes').onDelete('RESTRICT');
    table.date('prazo_anterior').notNullable();
    table.date('prazo_novo').notNullable();
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  for (const t of ['acao_registros', 'acao_prazos']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTable('acao_prazos');
  await knex.schema.dropTable('acao_registros');
  await knex.schema.dropTable('acoes');
};
