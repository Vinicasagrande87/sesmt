const cadastroDaFilial = require('./cadastroDaFilial');

module.exports = cadastroDaFilial({
  tabela: 'setores',
  nome: 'Setor',
  campos: ['nome', 'centro_custo', 'ativo'],
  obrigatorios: ['nome']
});
