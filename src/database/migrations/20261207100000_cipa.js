// CIPA (NR-5) por filial: mandatos (CIPA ou designado), membros, eleição com candidatos e votos, reuniões com ata.
// O dimensionamento da época fica gravado no mandato. Reuniões e votos só aceitam inclusão.
exports.up = async function(knex) {
  await knex.schema.createTable('cipa_mandatos', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('tipo', 10).notNullable();                    // cipa, designado
    table.date('inicio').notNullable();
    table.date('fim').notNullable();
    table.integer('grau_risco');                               // como estava ao abrir o mandato
    table.integer('empregados');
    table.integer('efetivos_exigidos').notNullable().defaultTo(0);
    table.integer('suplentes_exigidos').notNullable().defaultTo(0);
    table.text('observacao');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
    table.index(['filial_id', 'inicio']);
  });

  await knex.schema.createTable('cipa_membros', (table) => {
    table.increments('id').primary();
    table.integer('mandato_id').unsigned().notNullable().references('id').inTable('cipa_mandatos').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.string('representacao', 12).notNullable();          // empregador, empregados, designado
    table.string('condicao', 10).notNullable().defaultTo('titular'); // titular, suplente
    table.string('cargo', 20);                                 // presidente, vice_presidente, secretario
    table.integer('votos');
    table.date('inicio').notNullable();                        // posse
    table.date('fim');                                         // saída antes do fim do mandato
    table.text('motivo_saida');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['mandato_id']);
    table.index(['funcionario_id']);
  });

  // Eleição do mandato (representantes dos empregados)
  await knex.schema.createTable('cipa_eleicoes', (table) => {
    table.increments('id').primary();
    table.integer('mandato_id').unsigned().notNullable().unique().references('id').inTable('cipa_mandatos').onDelete('RESTRICT');
    table.date('edital_em').notNullable();
    table.date('inscricoes_inicio').notNullable();
    table.date('inscricoes_fim').notNullable();
    table.date('data_eleicao').notNullable();
    table.jsonb('alertas').notNullable().defaultTo('[]');      // prazos da NR-5 não atendidos
    table.integer('total_empregados');
    table.integer('votantes');
    table.string('resultado', 15);                             // apurada, sem_quorum
    table.uuid('ata_arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });
  await knex.schema.createTable('cipa_candidatos', (table) => {
    table.increments('id').primary();
    table.integer('eleicao_id').unsigned().notNullable().references('id').inTable('cipa_eleicoes').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.date('inscrito_em').notNullable();                   // início da estabilidade provisória
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['eleicao_id', 'funcionario_id']);
  });
  await knex.schema.createTable('cipa_votos', (table) => {
    table.increments('id').primary();
    table.integer('candidato_id').unsigned().notNullable().unique().references('id').inTable('cipa_candidatos').onDelete('RESTRICT');
    table.integer('votos').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('cipa_reunioes', (table) => {
    table.increments('id').primary();
    table.integer('mandato_id').unsigned().notNullable().references('id').inTable('cipa_mandatos').onDelete('RESTRICT');
    table.string('tipo', 15).notNullable();                    // ordinaria, extraordinaria
    table.date('data').notNullable();
    table.text('pauta').notNullable();
    table.text('ata').notNullable();
    table.jsonb('presentes').notNullable();                    // ids dos membros presentes
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT'); // ata assinada
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['mandato_id', 'data']);
  });
  await knex.schema.createTable('cipa_reuniao_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('reuniao_id').unsigned().notNullable().unique().references('id').inTable('cipa_reunioes').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  for (const t of ['cipa_votos', 'cipa_reunioes', 'cipa_reuniao_anulacoes', 'cipa_candidatos']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }
};

exports.down = async function(knex) {
  for (const t of ['cipa_reuniao_anulacoes', 'cipa_reunioes', 'cipa_votos', 'cipa_candidatos', 'cipa_eleicoes', 'cipa_membros', 'cipa_mandatos']) {
    await knex.schema.dropTable(t);
  }
};
