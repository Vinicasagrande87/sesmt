// Ocorrências de SST por filial: acidentes (típico, trajeto), doença ocupacional, incidentes e quase-acidentes.
// Vítimas (empregado, terceiro, estudante, visitante), testemunhas, CAT por vítima empregada (só inclusão),
// investigação com causas e anexos. Os campos do evento S-2210 do eSocial já ficam guardados.
// A tabela antiga (acidentes_trabalho) é copiada para cá e fica guardada como legado.
exports.up = async function(knex) {
  await knex.schema.createTable('ocorrencias', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('ano').notNullable();
    table.integer('sequencial').notNullable();                // número na filial: 2026/0003
    table.string('tipo', 30).notNullable();                   // acidente_tipico, acidente_trajeto, doenca_ocupacional, incidente, quase_acidente
    table.timestamp('data_hora').notNullable();               // quando aconteceu (doença: data do diagnóstico)
    table.integer('predio_id').unsigned().references('id').inTable('predios').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.string('local_descricao').notNullable();
    table.string('tipo_local', 2);                            // eSocial tpLocal: 1 estabelecimento do empregador ... 9 outros
    table.text('descricao').notNullable();                    // o que aconteceu
    table.text('atividade');                                  // o que estava sendo feito
    table.string('gravidade', 12);                            // leve, moderada, grave, fatal (real); quase-acidente: potencial
    table.string('gravidade_potencial', 12);
    table.string('horas_trabalhadas_antes', 5);               // eSocial hrsTrab (HH:MM)
    table.boolean('comunicou_policia');
    table.text('danos_materiais');
    table.string('status', 20).notNullable().defaultTo('aberta'); // aberta, em_investigacao, concluida, cancelada
    table.timestamp('concluida_em');
    table.integer('concluida_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.text('motivo_cancelamento');
    table.timestamp('cancelada_em');
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.boolean('legado').notNullable().defaultTo(false);   // veio da tabela antiga
    table.timestamps(true, true);
    table.unique(['filial_id', 'ano', 'sequencial']);
    table.index(['filial_id', 'data_hora']);
  });

  await knex.schema.createTable('ocorrencia_vitimas', (table) => {
    table.increments('id').primary();
    table.integer('ocorrencia_id').unsigned().notNullable().references('id').inTable('ocorrencias').onDelete('RESTRICT');
    table.string('vinculo', 20).notNullable();                // empregado, terceiro, estudante, visitante
    table.integer('funcionario_id').unsigned().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT'); // da época
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.string('nome');                                     // quem não é empregado
    table.string('documento', 30);
    table.string('empresa');                                  // terceiro: empresa contratada
    table.boolean('houve_lesao').notNullable().defaultTo(true);
    table.string('parte_corpo');
    table.string('parte_corpo_codigo', 12);                   // tabela 13 do eSocial
    table.string('lateralidade', 15);                         // esquerda, direita, ambas, nao_aplica
    table.string('natureza_lesao');
    table.string('natureza_lesao_codigo', 12);                // tabela 17
    table.string('agente_causador');
    table.string('agente_causador_codigo', 12);               // tabelas 14/15
    table.string('situacao_geradora');
    table.string('situacao_geradora_codigo', 12);             // tabela 16
    table.boolean('houve_afastamento').notNullable().defaultTo(false);
    table.date('data_afastamento');
    table.date('data_retorno');
    table.integer('dias_perdidos');                           // NBR 14280: dias corridos de afastamento
    table.integer('dias_debitados');                          // NBR 14280: morte 6000, incapacidade permanente (quadro)
    table.boolean('obito').notNullable().defaultTo(false);
    table.date('data_obito');
    // Dados médicos (LGPD): só saude/admin
    table.date('atestado_data');
    table.string('atestado_hora', 5);
    table.boolean('internacao');
    table.integer('duracao_tratamento_dias');
    table.string('cid', 10);
    table.text('diagnostico');
    table.string('medico_nome');
    table.string('medico_crm', 20);
    table.string('medico_uf', 2);
    table.timestamps(true, true);
    table.index(['ocorrencia_id']);
    table.index(['funcionario_id']);
  });

  await knex.schema.createTable('ocorrencia_testemunhas', (table) => {
    table.increments('id').primary();
    table.integer('ocorrencia_id').unsigned().notNullable().references('id').inTable('ocorrencias').onDelete('RESTRICT');
    table.integer('funcionario_id').unsigned().references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.string('nome').notNullable();
    table.string('contato');
    table.text('relato');
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // CAT: uma ou mais por vítima empregada (inicial, reabertura, óbito). Só inclusão; erro se anula.
  await knex.schema.createTable('cats', (table) => {
    table.increments('id').primary();
    table.integer('vitima_id').unsigned().notNullable().references('id').inTable('ocorrencia_vitimas').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('tipo', 12).notNullable();                   // inicial, reabertura, obito
    table.string('numero', 40).notNullable();                 // número do recibo (eSocial) ou da CAT
    table.date('data_emissao').notNullable();
    table.string('emitente', 20).notNullable().defaultTo('empregador'); // empregador, sindicato, medico, segurado, autoridade
    table.uuid('arquivo_id').references('id').inTable('arquivos').onDelete('RESTRICT');
    table.text('observacao');
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('cat_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('cat_id').unsigned().notNullable().unique().references('id').inTable('cats').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Investigação (uma por ocorrência). Concluída, fica travada.
  await knex.schema.createTable('ocorrencia_investigacoes', (table) => {
    table.increments('id').primary();
    table.integer('ocorrencia_id').unsigned().notNullable().unique().references('id').inTable('ocorrencias').onDelete('RESTRICT');
    table.string('metodo', 20).notNullable();                 // arvore_causas, cinco_porques, ishikawa, outro
    table.jsonb('equipe').notNullable();                      // nomes/funções de quem investigou
    table.date('data_inicio').notNullable();
    table.text('descricao_fatos');
    table.text('conclusao');
    table.jsonb('medidas_recomendadas');                      // lista de textos (o plano de ação vem a seguir)
    table.integer('responsavel_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });
  await knex.schema.createTable('ocorrencia_causas', (table) => {
    table.increments('id').primary();
    table.integer('investigacao_id').unsigned().notNullable().references('id').inTable('ocorrencia_investigacoes').onDelete('RESTRICT');
    table.string('tipo', 15).notNullable();                   // imediata, raiz, contribuinte
    table.string('categoria', 20).notNullable();              // mao_de_obra, metodo, maquina, material, meio_ambiente, medicao, gestao
    table.text('descricao').notNullable();
    table.integer('ordem').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('ocorrencia_anexos', (table) => {
    table.increments('id').primary();
    table.integer('ocorrencia_id').unsigned().notNullable().references('id').inTable('ocorrencias').onDelete('RESTRICT');
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT');
    table.string('descricao').notNullable();
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Horas-homem trabalhadas por filial e mês (base da taxa de frequência e de gravidade)
  await knex.schema.createTable('horas_trabalhadas', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('competencia', 7).notNullable();
    table.decimal('horas', 14, 2).notNullable();
    table.integer('informado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
    table.unique(['filial_id', 'competencia']);
  });

  // Só inclusão (como as demais provas da etapa 8)
  for (const t of ['cats', 'cat_anulacoes', 'ocorrencia_testemunhas', 'ocorrencia_anexos']) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }

  // Legado: cada registro antigo vira uma ocorrência (acidente típico) na filial do funcionário
  const usuario = await knex('usuarios').orderBy('id').first('id');
  const antigos = await knex('acidentes_trabalho as a').join('funcionarios as f', 'f.id', 'a.funcionario_id')
    .whereNotNull('f.filial_id').orderBy('a.id').select('a.*', 'f.filial_id', 'f.setor_id', 'f.funcao_id');
  const proximo = new Map();
  for (const a of antigos) {
    if (!usuario) break;
    const data = a.data_hora_acidente || new Date();
    const ano = Number(new Date(data).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 4));
    const chave = `${a.filial_id}:${ano}`;
    const sequencial = (proximo.get(chave) || 0) + 1;
    proximo.set(chave, sequencial);
    const [o] = await knex('ocorrencias').insert({
      filial_id: a.filial_id, ano, sequencial, tipo: 'acidente_tipico', data_hora: data, local_descricao: a.local_acidente,
      descricao: a.descricao_ocorrencia || '(registro antigo sem descrição)', status: 'aberta', registrado_por: usuario.id, legado: true
    }).returning('id');
    await knex('ocorrencia_vitimas').insert({
      ocorrencia_id: o.id, vinculo: 'empregado', funcionario_id: a.funcionario_id, setor_id: a.setor_id, funcao_id: a.funcao_id,
      parte_corpo: a.parte_corpo_atingida, houve_afastamento: !!a.houve_afastamento, dias_perdidos: a.dias_afastado
    });
  }
  await knex.schema.renameTable('acidentes_trabalho', 'acidentes_trabalho_legado');
};

exports.down = async function(knex) {
  await knex.schema.renameTable('acidentes_trabalho_legado', 'acidentes_trabalho');
  for (const t of ['horas_trabalhadas', 'ocorrencia_anexos', 'ocorrencia_causas', 'ocorrencia_investigacoes', 'cat_anulacoes', 'cats',
    'ocorrencia_testemunhas', 'ocorrencia_vitimas', 'ocorrencias']) {
    await knex.schema.dropTable(t);
  }
};
