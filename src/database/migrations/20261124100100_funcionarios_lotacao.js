// Liga o funcionário à filial (CNPJ empregador), setor e função, com histórico de lotações.
exports.up = async function(knex) {
  await knex.schema.alterTable('funcionarios', (table) => {
    table.integer('filial_id').unsigned().references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().references('id').inTable('funcoes').onDelete('RESTRICT');
    table.date('data_demissao');
    // cargo/setor em texto ficam só para registros antigos: o certo agora é funcao_id/setor_id
    table.string('cargo').nullable().alter();
    table.string('setor').nullable().alter();
  });

  // Matrícula é por empregador (CNPJ): duas filiais podem ter a mesma matrícula.
  // O CPF continua único: uma pessoa = um cadastro, com todo o histórico no grupo.
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropUnique(['matricula']);
    table.unique(['filial_id', 'matricula']);
  });

  await knex.schema.createTable('funcionario_lotacoes', (table) => {
    table.increments('id').primary();
    table.integer('funcionario_id').unsigned().notNullable()
      .references('id').inTable('funcionarios').onDelete('RESTRICT');
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.integer('setor_id').unsigned().notNullable()
      .references('id').inTable('setores').onDelete('RESTRICT');
    table.integer('funcao_id').unsigned().notNullable()
      .references('id').inTable('funcoes').onDelete('RESTRICT');
    table.date('inicio').notNullable();
    table.date('fim');                                        // null = lotação atual
    table.integer('registrado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['funcionario_id', 'inicio']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('funcionario_lotacoes');
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropUnique(['filial_id', 'matricula']);
    table.unique(['matricula']);
  });
  await knex.schema.alterTable('funcionarios', (table) => {
    table.dropForeign('filial_id');
    table.dropForeign('setor_id');
    table.dropForeign('funcao_id');
    table.dropColumn('filial_id');
    table.dropColumn('setor_id');
    table.dropColumn('funcao_id');
    table.dropColumn('data_demissao');
  });
};
