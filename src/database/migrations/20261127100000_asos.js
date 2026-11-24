// ASOs (NR-7): a clínica manda o PDF, digitamos o essencial para controlar vencimentos.
// Dado de saúde (LGPD, art. 11): detalhes e arquivo só para os perfis saude e admin.
// Nada é editado: ASO digitado errado se anula e se lança de novo.
exports.up = async function(knex) {
  // Periodicidade do exame periódico definida no PCMSO para cada função (NR-7: anual ou bienal)
  await knex.schema.alterTable('funcoes', (table) => {
    table.integer('periodicidade_aso_meses').notNullable().defaultTo(12);
  });

  // Grau de risco da filial (NR-4): define a dispensa do exame demissional (NR-7 7.5.11)
  await knex.schema.alterTable('filiais', (table) => {
    table.integer('grau_risco');
  });

  await knex.schema.createTable('asos', (table) => {
    table.increments('id').primary();
    table.integer('funcionario_id').unsigned().notNullable()
      .references('id').inTable('funcionarios').onDelete('RESTRICT');
    // retrato da lotação no dia do registro
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.string('tipo', 20).notNullable();          // admissional, periodico, retorno_trabalho, mudanca_risco, demissional
    table.date('data_exame').notNullable();
    table.string('resultado', 20).notNullable();     // apto, apto_restricao, inapto
    table.date('data_vencimento');                    // próximo periódico; null para demissional e inapto
    // detalhes (somente saude/admin)
    table.string('medico_nome').notNullable();
    table.string('medico_crm', 20).notNullable();
    table.string('medico_uf', 2);
    table.string('clinica');
    table.text('riscos');
    table.text('exames_complementares');
    table.text('restricoes');
    table.text('observacao');
    table.uuid('arquivo_id').notNullable().references('id').inTable('arquivos').onDelete('RESTRICT');
    table.integer('registrado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['funcionario_id', 'data_exame']);
  });

  await knex.schema.createTable('aso_anulacoes', (table) => {
    table.increments('id').primary();
    table.integer('aso_id').unsigned().notNullable().unique()
      .references('id').inTable('asos').onDelete('RESTRICT');
    table.text('motivo').notNullable();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('aso_anulacoes');
  await knex.schema.dropTable('asos');
  await knex.schema.alterTable('filiais', (table) => table.dropColumn('grau_risco'));
  await knex.schema.alterTable('funcoes', (table) => table.dropColumn('periodicidade_aso_meses'));
};
