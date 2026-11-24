// Contas: versão da sessão (trocar a senha ou desativar derruba os logins abertos) e redefinição de senha
// por e-mail. Avisos: destinatários extras dos e-mails de vencimento e o registro de cada envio.
exports.up = async function(knex) {
  await knex.schema.alterTable('usuarios', (table) => {
    table.integer('sessao_versao').notNullable().defaultTo(0);
    table.timestamp('senha_alterada_em');
  });

  // Link de redefinição: guardamos só o SHA-256 do token; vale 1 hora e uma vez
  await knex.schema.createTable('senha_redefinicoes', (table) => {
    table.increments('id').primary();
    table.integer('usuario_id').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.string('token_hash', 64).notNullable().unique();
    table.timestamp('expira_em').notNullable();
    table.timestamp('usado_em');
    table.string('ip', 64);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Além dos admins (que recebem tudo), quem mais recebe os avisos; filial_ids null = todas as filiais
  await knex.schema.createTable('aviso_destinatarios', (table) => {
    table.increments('id').primary();
    table.string('nome').notNullable();
    table.string('email').notNullable().unique();
    table.jsonb('filial_ids');
    table.boolean('ativo').notNullable().defaultTo(true);
    table.integer('criado_por').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamps(true, true);
  });

  // Cada rodada de avisos: a referência única impede enviar duas vezes a mesma semana
  await knex.schema.createTable('aviso_envios', (table) => {
    table.increments('id').primary();
    table.string('referencia', 40).notNullable().unique();     // semana-2026-W48 ou manual-...
    table.string('tipo', 12).notNullable();                    // automatico, manual
    table.date('limite').notNullable();                        // avisou o que vence até esta data
    table.jsonb('resultado');                                  // [{ email, itens, enviado, erro }]
    table.integer('usuario_id').unsigned().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('concluido_em');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTable('aviso_envios');
  await knex.schema.dropTable('aviso_destinatarios');
  await knex.schema.dropTable('senha_redefinicoes');
  await knex.schema.alterTable('usuarios', (table) => {
    table.dropColumns('sessao_versao', 'senha_alterada_em');
  });
};
