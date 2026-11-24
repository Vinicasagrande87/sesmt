// PGR (NR-1) por filial e ordens de serviço com ciência do trabalhador (NR-1, item 1.4.1, "c").
// O PGR é carregado pela filial como rascunho (grupos de exposição: setor + funções), conferido e publicado.
// Publicado, ele fica congelado: cada grupo gera uma OS com o conteúdo "fotografado" (jsonb + SHA-256),
// e a ciência do funcionário aponta para essa fotografia. Correção = nova revisão do PGR.
exports.up = async function(knex) {
  await knex.schema.createTable('pgrs', (table) => {
    table.increments('id').primary();
    table.string('titulo').notNullable();
    table.date('data_inicio').notNullable();
    table.date('data_fim').notNullable();
    table.string('responsavel_nome').notNullable();
    table.string('responsavel_registro').notNullable();      // ex.: CREA-RS 000000
    table.string('responsavel_titulacao');
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT'); // PDF assinado
    table.string('status', 20).notNullable().defaultTo('rascunho'); // rascunho, vigente, substituido
    table.integer('revisao_de').unsigned().references('id').inTable('pgrs').onDelete('RESTRICT');
    table.integer('criado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.integer('publicado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('publicado_em');
    table.timestamp('substituido_em');
    table.timestamps(true, true);
  });

  // Um PGR pode cobrir mais de um estabelecimento (CNPJ)
  await knex.schema.createTable('pgr_filiais', (table) => {
    table.integer('pgr_id').unsigned().notNullable().references('id').inTable('pgrs').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.primary(['pgr_id', 'filial_id']);
  });

  // Grupo de exposição (cada "ficha" do PGR): setor + atividade + funções expostas
  await knex.schema.createTable('pgr_grupos', (table) => {
    table.increments('id').primary();
    table.integer('pgr_id').unsigned().notNullable().references('id').inTable('pgrs').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().notNullable().references('id').inTable('setores').onDelete('RESTRICT');
    table.string('atividade').notNullable();
    table.text('descricao_atividades');
    table.text('medidas_controle');
    table.text('observacao_epi');
    table.string('unidade_fisica');
    table.string('conclusao_gfip', 2);
    table.integer('ordem').notNullable().defaultTo(0);
    table.index(['pgr_id']);
  });

  // Cada (setor, função) só pode estar em um grupo do mesmo PGR: é assim que se acha a OS do funcionário
  await knex.schema.createTable('pgr_grupo_funcoes', (table) => {
    table.integer('grupo_id').unsigned().notNullable().references('id').inTable('pgr_grupos').onDelete('RESTRICT');
    table.integer('pgr_id').unsigned().notNullable().references('id').inTable('pgrs').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().notNullable().references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().notNullable().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.primary(['grupo_id', 'funcao_id']);
    table.unique(['pgr_id', 'setor_id', 'funcao_id']);
  });

  // Inventário de riscos: só as linhas que existem (o checklist vazio do PDF não precisa ser digitado)
  await knex.schema.createTable('pgr_riscos', (table) => {
    table.increments('id').primary();
    table.integer('grupo_id').unsigned().notNullable().references('id').inTable('pgr_grupos').onDelete('RESTRICT');
    table.string('categoria', 20).notNullable();          // fisico, quimico, biologico, acidente, ergonomico
    table.string('agente').notNullable();                 // Ruído, Calor, Formaldeído, Trabalho em altura...
    table.string('referencia');                           // NR 15 (anexo 1), NR 35...
    table.text('fonte_geradora');
    table.string('exposicao');                            // intermitente, permanente, eventual
    table.string('medicao');                              // 62,65 dB(A), IBUTG 24,3 °C, qualitativa...
    table.string('epc');
    table.integer('probabilidade');                       // 1 a 5 (matriz AIHA)
    table.integer('efeito');                              // 1 a 5
    table.string('nivel', 20);                            // calculado: trivial, baixo, moderado, alto, muito_alto
  });

  await knex.schema.createTable('pgr_epis', (table) => {
    table.increments('id').primary();
    table.integer('grupo_id').unsigned().notNullable().references('id').inTable('pgr_grupos').onDelete('RESTRICT');
    table.string('parte_corpo', 30).notNullable();
    table.text('descricao').notNullable();                // como está no PGR
    table.integer('epi_id').unsigned().references('id').inTable('epis').onDelete('RESTRICT'); // vínculo com o catálogo
  });

  await knex.schema.createTable('pgr_treinamentos', (table) => {
    table.increments('id').primary();
    table.integer('grupo_id').unsigned().notNullable().references('id').inTable('pgr_grupos').onDelete('RESTRICT');
    table.string('descricao').notNullable();
    table.integer('treinamento_id').unsigned().references('id').inTable('treinamentos').onDelete('RESTRICT');
  });

  // OS gerada na publicação: fotografia do conteúdo, que nunca muda
  await knex.schema.createTable('ordens_servico', (table) => {
    table.increments('id').primary();
    table.integer('pgr_id').unsigned().notNullable().references('id').inTable('pgrs').onDelete('RESTRICT');
    table.integer('grupo_id').unsigned().notNullable().unique().references('id').inTable('pgr_grupos').onDelete('RESTRICT');
    table.jsonb('conteudo').notNullable();
    table.string('hash', 64).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('os_ciencias', (table) => {
    table.increments('id').primary();
    table.integer('ordem_servico_id').unsigned().notNullable().references('id').inTable('ordens_servico').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().notNullable().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.timestamp('assinado_em').notNullable().defaultTo(knex.fn.now());
    table.date('data_ciencia').notNullable();
    table.string('metodo_assinatura', 20).notNullable();  // qr_pin, manual
    table.boolean('pin_validado').notNullable().defaultTo(false);
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('ip', 64);
    table.string('user_agent', 300);
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.text('observacao');
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT'); // OS em papel digitalizada
    table.index(['funcionario_id']);
  });

  await knex.schema.createTable('os_ciencia_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('ciencia_id').unsigned().notNullable().unique().references('id').inTable('os_ciencias').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  for (const tabela of ['os_ciencia_anulacoes', 'os_ciencias', 'ordens_servico', 'pgr_treinamentos', 'pgr_epis',
    'pgr_riscos', 'pgr_grupo_funcoes', 'pgr_grupos', 'pgr_filiais', 'pgrs']) {
    await knex.schema.dropTable(tabela);
  }
};
