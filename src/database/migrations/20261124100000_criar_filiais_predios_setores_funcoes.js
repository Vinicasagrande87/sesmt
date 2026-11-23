// Estrutura da empresa: matriz/filiais (cada uma com CNPJ próprio), prédios, setores e funções.
exports.up = async function(knex) {
  await knex.schema.createTable('filiais', (table) => {
    table.increments('id').primary();
    table.string('nome').notNullable();                       // ex.: Campus Guaíba
    table.string('tipo', 30).notNullable().defaultTo('Campus'); // Campus, Colégio, Sede...
    table.boolean('matriz').notNullable().defaultTo(false);
    table.string('cnpj', 14).notNullable().unique();          // só dígitos
    table.string('razao_social');
    table.string('uf', 2).notNullable();
    table.string('cidade').notNullable();
    table.string('codigo_ibge', 7);                           // código do município (opcional)
    table.string('bairro').notNullable();
    table.string('cep', 8);
    table.string('logradouro');
    table.string('numero', 20);
    table.string('complemento');
    table.boolean('ativa').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });

  await knex.schema.createTable('predios', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('nome').notNullable();                       // ex.: Prédio 11
    // Endereço próprio só quando diferente do da filial
    table.string('cep', 8);
    table.string('logradouro');
    table.string('numero', 20);
    table.string('bairro');
    table.decimal('area_m2', 12, 2);
    table.decimal('altura_m', 8, 2);
    table.string('ocupacao');                                 // classificação de ocupação/risco
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamps(true, true);
    table.unique(['filial_id', 'nome']);
  });

  await knex.schema.createTable('setores', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable()
      .references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('nome').notNullable();
    table.string('centro_custo', 30);
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamps(true, true);
    table.unique(['filial_id', 'nome']);
  });

  // Catálogo único do grupo (só a matriz cadastra)
  await knex.schema.createTable('funcoes', (table) => {
    table.increments('id').primary();
    table.string('nome').notNullable().unique();
    table.string('cbo', 6);
    table.text('descricao');
    table.boolean('ativa').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('funcoes');
  await knex.schema.dropTable('setores');
  await knex.schema.dropTable('predios');
  await knex.schema.dropTable('filiais');
};
