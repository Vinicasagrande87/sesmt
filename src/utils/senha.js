const { ErroDeNegocio } = require('./erros');

// 8 a 72 caracteres (o bcrypt ignora o que passa de 72 bytes); não pode ser o próprio e-mail
function validarSenha(senha, email) {
  const s = String(senha ?? '');
  if (s.length < 8) throw new ErroDeNegocio(400, 'A senha precisa ter pelo menos 8 caracteres');
  if (Buffer.byteLength(s) > 72) throw new ErroDeNegocio(400, 'A senha pode ter no máximo 72 caracteres');
  if (email && s.trim().toLowerCase() === String(email).trim().toLowerCase()) throw new ErroDeNegocio(400, 'A senha não pode ser o seu e-mail');
  return s;
}

module.exports = { validarSenha };
