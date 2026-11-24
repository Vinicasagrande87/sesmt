// Erro esperado (regra de negócio): vira resposta 4xx com a mensagem.
// Lançado dentro de knex.transaction, também desfaz a transação.
class ErroDeNegocio extends Error {
  constructor(status, message, detalhes) {
    super(message);
    this.status = status;
    this.detalhes = detalhes;
  }
}

// Mensagens amigáveis para os índices únicos mais comuns
const MENSAGENS_UNICAS = {
  funcionarios_filial_id_matricula_unique: 'Esta matrícula já está em uso nesta filial',
  funcionarios_cpf_unique: 'Já existe um funcionário com este CPF',
  filiais_cnpj_unique: 'Já existe uma filial com este CNPJ',
  setores_filial_id_nome_unique: 'Já existe um setor com este nome nesta filial',
  predios_filial_id_nome_unique: 'Já existe um prédio com este nome nesta filial',
  funcoes_nome_unique: 'Já existe uma função com este nome',
  equipamentos_incendio_filial_id_identificacao_unique: 'Já existe um equipamento com esta identificação nesta filial'
};

// Middleware final do Express: transforma qualquer erro em resposta JSON
// eslint-disable-next-line no-unused-vars
function tratarErros(error, req, res, next) {
  if (error instanceof ErroDeNegocio) {
    return res.status(error.status).json({ error: error.message, ...(error.detalhes || {}) });
  }

  // JSON mal formado no corpo da requisição
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
  }

  // Erros do Postgres que são culpa dos dados enviados
  switch (error.code) {
    case '23505': // unique_violation
      return res.status(409).json({ error: MENSAGENS_UNICAS[error.constraint] || 'Já existe um registro com esses dados', campo: error.constraint });
    case '23503': // foreign_key_violation
      return res.status(409).json({ error: 'Registro relacionado não existe ou está em uso' });
    case '22P02': // invalid_text_representation (ex.: "abc" num campo numérico)
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '23502': // not_null_violation
      return res.status(400).json({ error: 'Dados inválidos' });
    default:
      console.error(error);
      return res.status(500).json({ error: 'Erro interno' });
  }
}

module.exports = { ErroDeNegocio, tratarErros };
