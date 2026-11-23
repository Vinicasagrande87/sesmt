// As tabelas antigas usavam ON DELETE CASCADE: apagar um funcionário ou EPI apagava junto
// o histórico de entregas, treinamentos e acidentes (justamente a prova legal).
// Agora o banco recusa apagar quem tem histórico (RESTRICT); o sistema inativa em vez de apagar.

const LIGACOES = [
  ['entregas', 'funcionario_id', 'funcionarios'],
  ['entregas', 'epi_id', 'epis'],
  ['estoque_movimentacao', 'epi_id', 'epis'],
  ['certificados_treinamentos', 'funcionario_id', 'funcionarios'],
  ['certificados_treinamentos', 'treinamento_id', 'treinamentos'],
  ['acidentes_trabalho', 'funcionario_id', 'funcionarios']
];

async function trocar(knex, acao) {
  for (const [tabela, coluna, referencia] of LIGACOES) {
    await knex.schema.alterTable(tabela, (table) => {
      table.dropForeign(coluna);
      table.foreign(coluna).references('id').inTable(referencia).onDelete(acao);
    });
  }
}

exports.up = (knex) => trocar(knex, 'RESTRICT');
exports.down = (knex) => trocar(knex, 'CASCADE');
