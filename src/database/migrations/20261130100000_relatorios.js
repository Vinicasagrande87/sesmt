// Relatórios (etapa 7): o que faltava para responder "como estava em uma data" e o registro
// de cada relatório emitido (código de verificação + SHA-256 do conteúdo e do arquivo).
exports.up = async function(knex) {
  // Desde quando cada função exige cada treinamento (funcao_treinamentos guarda só a lista atual)
  await knex.schema.createTable('funcao_treinamento_vigencias', (table) => {
    table.increments('id').primary();
    table.integer('funcao_id').unsigned().notNullable().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.integer('treinamento_id').unsigned().notNullable().references('id').inTable('treinamentos').onDelete('RESTRICT');
    table.timestamp('inicio').notNullable();
    table.timestamp('fim');                                   // null = exigência atual
    table.integer('usuario_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.index(['funcao_id', 'inicio']);
  });
  // Exigências que já existiam: sem data conhecida, valem "desde sempre"
  await knex.raw(`
    insert into funcao_treinamento_vigencias (funcao_id, treinamento_id, inicio)
    select funcao_id, treinamento_id, timestamptz '2000-01-01 00:00:00-03' from funcao_treinamentos`);

  // Onde o equipamento estava e se estava ativo, a partir de quando (mudança de prédio, baixa, reativação)
  await knex.schema.createTable('equipamento_historico', (table) => {
    table.increments('id').primary();
    table.integer('equipamento_id').unsigned().notNullable().references('id').inTable('equipamentos_incendio').onDelete('RESTRICT');
    table.integer('predio_id').unsigned().notNullable().references('id').inTable('predios').onDelete('RESTRICT');
    table.boolean('ativo').notNullable();
    table.timestamp('inicio').notNullable().defaultTo(knex.fn.now());
    table.integer('usuario_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.index(['equipamento_id', 'inicio']);
  });
  await knex.raw(`
    insert into equipamento_historico (equipamento_id, predio_id, ativo, inicio)
    select id, predio_id, true, created_at from equipamentos_incendio`);
  await knex.raw(`
    insert into equipamento_historico (equipamento_id, predio_id, ativo, inicio)
    select id, predio_id, false, updated_at from equipamentos_incendio where not ativo`);

  // Cada relatório emitido (PDF ou Excel). O conteúdo fica guardado: dá para conferir uma via impressa.
  await knex.schema.createTable('relatorios_emitidos', (table) => {
    table.increments('id').primary();
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.string('tipo', 30).notNullable();                   // conformidade, treinamentos, asos, ordens_servico, ppci
    table.string('formato', 5).notNullable();                 // pdf, xlsx
    table.date('data_base').notNullable();                    // situação "como estava" nesta data
    table.jsonb('parametros').notNullable();
    table.jsonb('filial_ids').notNullable();
    table.jsonb('resumo').notNullable();
    table.jsonb('conteudo').notNullable();
    table.integer('total_itens').notNullable();
    table.string('hash_conteudo', 64).notNullable();          // SHA-256 do conteúdo (JSON)
    table.string('hash_arquivo', 64).notNullable();           // SHA-256 do arquivo entregue
    table.integer('emitido_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('emitido_em').notNullable().defaultTo(knex.fn.now());
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.index(['emitido_em']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('relatorios_emitidos');
  await knex.schema.dropTable('equipamento_historico');
  await knex.schema.dropTable('funcao_treinamento_vigencias');
};
