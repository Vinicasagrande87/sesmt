// Fornecedores de cada filial (cada filial cuida das próprias compras)
const cadastroDaFilial = require('./cadastroDaFilial');
const { ErroDeNegocio } = require('../utils/erros');
const { somenteDigitos, cnpjValido } = require('../utils/validacao');

module.exports = cadastroDaFilial({
  tabela: 'fornecedores',
  nome: 'Fornecedor',
  campos: ['nome', 'cnpj', 'contato', 'ativo'],
  obrigatorios: ['nome'],
  validarExtra(dados) {
    if (dados.cnpj) {
      dados.cnpj = somenteDigitos(dados.cnpj);
      if (!cnpjValido(dados.cnpj)) throw new ErroDeNegocio(400, 'CNPJ do fornecedor inválido');
    }
    return dados;
  }
});
