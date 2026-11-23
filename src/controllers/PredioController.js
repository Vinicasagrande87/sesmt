const cadastroDaFilial = require('./cadastroDaFilial');

module.exports = cadastroDaFilial({
  tabela: 'predios',
  nome: 'Prédio',
  campos: ['nome', 'cep', 'logradouro', 'numero', 'bairro', 'area_m2', 'altura_m', 'ocupacao', 'ativo'],
  obrigatorios: ['nome']
});
