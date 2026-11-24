// Permissão de trabalho: altura (NR-35), espaço confinado (NR-33, PET), trabalho a quente e eletricidade (NR-10).
// Na emissão, o sistema confere treinamento e ASO de cada participante e guarda essa conferência.
// A permissão só é liberada depois que cada participante assina com o crachá (QR + PIN).
exports.up = async function(knex) {
  await knex.schema.createTable('permissoes_trabalho', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('ano').notNullable();
    table.integer('sequencial').notNullable();
    table.string('tipo', 20).notNullable();                    // altura, espaco_confinado, quente, eletricidade
    table.integer('predio_id').unsigned().references('id').inTable('predios').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.string('local_descricao', 300).notNullable();
    table.text('servico').notNullable();                       // o que será feito
    table.timestamp('inicio').notNullable();
    table.timestamp('fim').notNullable();
    table.jsonb('checklist').notNullable();                    // { item: true | null (não se aplica) }
    table.text('medidas_adicionais');
    table.text('epis');
    table.string('status', 25).notNullable().defaultTo('aguardando_assinaturas'); // aguardando_assinaturas, liberada, encerrada, cancelada
    table.integer('emitida_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('liberada_em');
    table.timestamp('encerrada_em');
    table.integer('encerrada_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.text('encerramento_observacao');
    table.timestamp('cancelada_em');
    table.integer('cancelada_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.text('motivo_cancelamento');
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.timestamps(true, true);
    table.unique(['filial_id', 'ano', 'sequencial']);
    table.index(['filial_id', 'inicio']);
  });

  await knex.schema.createTable('pt_participantes', (table) => {
    table.increments('id').primary();
    table.integer('pt_id').unsigned().notNullable().references('id').inTable('permissoes_trabalho').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.string('papel', 25).notNullable();                   // executante, vigia, supervisor_entrada, observador
    table.jsonb('conferencia').notNullable();                  // treinamentos e ASO conferidos na emissão
    table.unique(['pt_id', 'funcionario_id']);
  });

  // Ciência de cada participante (crachá + PIN, ou manual pela gestão). Só inclusão.
  await knex.schema.createTable('pt_assinaturas', (table) => {
    table.increments('id').primary();
    table.integer('participante_id').unsigned().notNullable().unique().references('id').inTable('pt_participantes').onDelete('RESTRICT');
    table.timestamp('assinado_em').notNullable().defaultTo(knex.fn.now());
    table.string('metodo', 10).notNullable();                  // qr_pin, manual
    table.boolean('pin_validado').notNullable();
    table.text('observacao');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
  });

  // Medições de atmosfera (espaço confinado; trabalho a quente quando houver). Só inclusão.
  await knex.schema.createTable('pt_medicoes', (table) => {
    table.increments('id').primary();
    table.integer('pt_id').unsigned().notNullable().references('id').inTable('permissoes_trabalho').onDelete('RESTRICT');
    table.timestamp('medido_em').notNullable().defaultTo(knex.fn.now());
    table.decimal('o2', 5, 2);                                 // % de oxigênio
    table.decimal('lie', 5, 2);                                // % do limite inferior de explosividade
    table.decimal('h2s', 7, 2);                                // ppm
    table.decimal('co', 7, 2);                                 // ppm
    table.string('equipamento', 100);                          // detector usado (nº de série)
    table.boolean('dentro_limites').notNullable();
    table.text('observacao');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
  });

  // Treinamentos exigidos por tipo de permissão e papel (definidos pela matriz). Sem nada aqui, vale a NR do tipo.
  await knex.schema.createTable('pt_exigencias', (table) => {
    table.string('tipo', 20).notNullable();
    table.string('papel', 25).notNullable();
    table.integer('treinamento_id').unsigned().notNullable().references('id').inTable('treinamentos').onDelete('RESTRICT');
    table.primary(['tipo', 'papel', 'treinamento_id']);
  });

  for (const t of ['pt_participantes', 'pt_assinaturas', 'pt_medicoes']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }
};

exports.down = async function(knex) {
  for (const t of ['pt_exigencias', 'pt_medicoes', 'pt_assinaturas', 'pt_participantes', 'permissoes_trabalho']) await knex.schema.dropTable(t);
};
