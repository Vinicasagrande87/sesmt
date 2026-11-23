const { ErroDeNegocio } = require('./erros');

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

function somenteDigitos(valor) {
  return valor == null ? valor : String(valor).replace(/\D/g, '');
}

function cpfValido(cpf) {
  const d = somenteDigitos(cpf);
  if (!d || d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(d[i]) * (tamanho + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(d[tamanho])) return false;
  }
  return true;
}

function cnpjValido(cnpj) {
  const d = somenteDigitos(cnpj);
  if (!d || d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const tamanho of [12, 13]) {
    let soma = 0;
    let peso = tamanho - 7;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(d[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    const digito = resto < 2 ? 0 : 11 - resto;
    if (digito !== Number(d[tamanho])) return false;
  }
  return true;
}

// Copia do corpo só os campos permitidos (evita gravar colunas que o usuário não deveria mexer)
function pegar(corpo, campos) {
  const resultado = {};
  for (const campo of campos) {
    if (corpo && corpo[campo] !== undefined) resultado[campo] = corpo[campo];
  }
  return resultado;
}

// Lança 400 listando os campos obrigatórios que faltam
function exigirCampos(corpo, campos) {
  const faltando = campos.filter((c) => !corpo || corpo[c] === undefined || corpo[c] === null || corpo[c] === '');
  if (faltando.length) {
    throw new ErroDeNegocio(400, 'Campos obrigatórios ausentes', { campos: faltando });
  }
}

function idValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

module.exports = { UFS, somenteDigitos, cpfValido, cnpjValido, pegar, exigirCampos, idValido };
