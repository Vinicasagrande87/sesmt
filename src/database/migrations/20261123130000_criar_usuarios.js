// Usuários do sistema (técnicos do SESMT) que fazem login e recebem o JWT.
// Não confundir com funcionários: funcionário recebe EPI, usuário opera o sistema.
exports.up = function(knex) {
  return knex.schema.createTable('usuarios', (table) => {
    table.increments('id').primary();
    table.string('nome').notNullable();
    table.string('email').notNullable().unique();
    table.string('senha_hash', 60).notNullable(); // bcrypt gera 60 caracteres
    table.string('perfil', 20).notNullable().defaultTo('tecnico'); // 'admin' | 'tecnico'
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('usuarios');
};
