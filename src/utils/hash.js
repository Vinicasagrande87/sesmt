// SHA-256 e JSON canônico (chaves em ordem alfabética, em todos os níveis): o mesmo dado gera sempre
// o mesmo texto, mesmo depois de passar pelo jsonb do Postgres (que reordena as chaves).
const crypto = require('crypto');

function canonico(valor) {
  if (valor === null || valor === undefined) return 'null';
  if (valor instanceof Date) return JSON.stringify(valor.toISOString());
  if (Buffer.isBuffer(valor)) return JSON.stringify(valor.toString('base64'));
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (typeof valor === 'object') {
    return `{${Object.keys(valor).filter((k) => valor[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  }
  if (typeof valor === 'bigint') return valor.toString();
  return JSON.stringify(valor);
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const hashCanonico = (valor) => sha256(canonico(valor));

module.exports = { canonico, sha256, hashCanonico };
