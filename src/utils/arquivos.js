// Recebe arquivos em base64 (ex.: foto tirada no celular), confere o tipo real pelo conteúdo,
// calcula o SHA-256 e grava na tabela arquivos.
const crypto = require('crypto');
const { ErroDeNegocio } = require('./erros');

const ASSINATURAS = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: (b) => b.slice(8, 12).toString() === 'WEBP' },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }
];

function detectarTipo(buffer) {
  return ASSINATURAS.find((a) => a.bytes.every((b, i) => buffer[i] === b) && (!a.extra || a.extra(buffer)));
}

// Aceita "data:image/jpeg;base64,...." ou só o base64
function decodificar(base64) {
  if (typeof base64 !== 'string' || !base64.length) throw new ErroDeNegocio(400, 'Arquivo vazio');
  const limpo = base64.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(limpo)) throw new ErroDeNegocio(400, 'Arquivo em base64 inválido');
  return Buffer.from(limpo, 'base64');
}

async function salvarArquivo(trx, req, { base64, contexto, tipos, maxBytes, filial_id, funcionario_id, nome }) {
  const buffer = decodificar(base64);
  if (buffer.length > maxBytes) {
    throw new ErroDeNegocio(413, `Arquivo muito grande: máximo ${(maxBytes / 1024 / 1024).toFixed(1)} MB`);
  }
  const tipo = detectarTipo(buffer);
  if (!tipo || !tipos.includes(tipo.mime)) {
    throw new ErroDeNegocio(400, `Tipo de arquivo não aceito. Aceitos: ${tipos.join(', ')}`);
  }

  const id = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  await trx('arquivos').insert({
    id,
    nome: nome || `${contexto}-${id}.${tipo.ext}`,
    tipo_mime: tipo.mime,
    tamanho: buffer.length,
    sha256,
    contexto,
    filial_id: filial_id || null,
    funcionario_id: funcionario_id || null,
    armazenamento: 'banco',
    conteudo: buffer,
    enviado_por: req.usuario.id
  });
  return { id, sha256, tipo_mime: tipo.mime, tamanho: buffer.length };
}

module.exports = { salvarArquivo, detectarTipo };
