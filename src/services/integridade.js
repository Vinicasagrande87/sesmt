// Cadeia de hash da auditoria.
// A linha é gravada na transação da operação (sem travar nada a mais) e selada logo depois, em ordem:
// sequencia = anterior + 1; hash = SHA-256(hash_anterior + conteúdo canônico da linha).
// Alterar, apagar ou inserir uma linha no meio quebra a cadeia a partir dali.
// A selagem roda depois das requisições que auditaram algo, a cada minuto e antes de conferir/fechar.
const { canonico, sha256 } = require('../utils/hash');

const TRAVA_SELAGEM = 70010001; // pg_advisory_xact_lock: uma selagem por vez
const GENESIS = '0'.repeat(64);
const LOTE = 500;

const CAMPOS = ['id', 'usuario_id', 'acao', 'tabela', 'registro_id', 'filial_id', 'antes', 'depois', 'ip', 'created_at'];

function hashDaLinha(linha, sequencia, hashAnterior) {
  const conteudo = Object.fromEntries(CAMPOS.map((c) => [c, linha[c] === undefined ? null : linha[c]]));
  conteudo.id = String(linha.id);
  conteudo.sequencia = String(sequencia);
  return sha256(`${hashAnterior}|${canonico(conteudo)}`);
}

// Sela as linhas pendentes em ordem de id. Devolve quantas selou.
async function selarAuditoria(db) {
  let total = 0;
  for (;;) {
    const selados = await db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(?)', [TRAVA_SELAGEM]);
      const ultima = await trx('auditoria').whereNotNull('sequencia').orderBy('sequencia', 'desc').first('sequencia', 'hash');
      let sequencia = ultima ? Number(ultima.sequencia) : 0;
      let anterior = ultima ? ultima.hash : GENESIS;
      const pendentes = await trx('auditoria').whereNull('hash').orderBy('id').limit(LOTE).select(CAMPOS);
      for (const linha of pendentes) {
        sequencia += 1;
        const hash = hashDaLinha(linha, sequencia, anterior);
        await trx('auditoria').where({ id: linha.id }).update({ sequencia, hash_anterior: anterior, hash, selado_em: trx.fn.now() });
        anterior = hash;
      }
      return pendentes.length;
    });
    total += selados;
    if (selados < LOTE) return total;
  }
}

// Confere a cadeia inteira (em lotes). Para na primeira quebra.
async function verificarCadeia(db) {
  let anterior = GENESIS;
  let esperado = 1;
  let ultimo = 0;
  for (;;) {
    const linhas = await db('auditoria').whereNotNull('sequencia').where('sequencia', '>', ultimo)
      .orderBy('sequencia').limit(2000).select([...CAMPOS, 'sequencia', 'hash_anterior', 'hash']);
    if (!linhas.length) break;
    for (const l of linhas) {
      const seq = Number(l.sequencia);
      const falha = (motivo) => ({ ok: false, verificados: seq - 1, falha: { sequencia: seq, auditoria_id: Number(l.id), motivo } });
      if (seq !== esperado) return { ok: false, verificados: esperado - 1, falha: { sequencia: esperado, auditoria_id: null, motivo: 'linha ausente na sequência' } };
      if (l.hash_anterior !== anterior) return falha('hash_anterior não confere com a linha anterior');
      if (hashDaLinha(l, seq, anterior) !== l.hash) return falha('conteúdo alterado depois de selado');
      anterior = l.hash;
      esperado += 1;
      ultimo = seq;
    }
  }
  const pendentes = Number((await db('auditoria').whereNull('hash').count({ n: '*' }).first()).n);
  return { ok: true, verificados: esperado - 1, pendentes, ultima: ultimo ? { sequencia: ultimo, hash: anterior } : null };
}

// Selagem em segundo plano: no máximo uma rodando; se pedirem durante, roda de novo ao terminar.
let rodando = null;
let deNovo = false;
let pendente = false;
function marcarPendente() { pendente = true; }
function agendarSelagem(db) {
  if (!pendente) return rodando;
  if (rodando) { deNovo = true; return rodando; }
  pendente = false;
  rodando = selarAuditoria(db)
    .catch(() => { pendente = true; }) // banco indisponível: tenta na próxima
    .finally(() => {
      rodando = null;
      if (deNovo) { deNovo = false; pendente = true; agendarSelagem(db); }
    });
  return rodando;
}

module.exports = { selarAuditoria, verificarCadeia, agendarSelagem, marcarPendente, hashDaLinha, GENESIS };
