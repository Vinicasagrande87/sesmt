// Planilha de importação do PGR: escreve -> lê -> a API aceita os grupos lidos.
// Também confere que a leitura aponta os problemas (categoria inválida, setor + função repetidos).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');
const { escreverPlanilha, lerPlanilha } = require('../scripts/pgr-planilha');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-planilha-'));
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% PGR de exemplo\n%%EOF').toString('base64');

const grupos = () => [
  {
    numero: 1, setor: 'Manutenção', atividade: 'Atividades em eletricidade', funcoes: ['Eletricista', 'Encarregado de Elétrica'],
    descricao_atividades: 'Manutenção da rede elétrica.', medidas_controle: 'Bloqueio e etiquetagem.', conclusao_gfip: '01', unidade_fisica: 'Prédio 9',
    riscos: [
      { categoria: 'fisico', agente: 'Ruído contínuo', referencia: 'NR 15 (anexo 1)', medicao: '62,65 dB(A)', probabilidade: 2, efeito: 2 },
      { categoria: 'acidente', agente: 'Trabalho em altura', referencia: 'NR 35' }
    ],
    epis: [{ parte_corpo: 'maos', descricao: 'Luva para agentes mecânicos' }, { parte_corpo: 'corpo', descricao: 'Cinto para trabalho em altura' }],
    treinamentos: ['ORDEM DE SERVIÇO (NR 1) - INTEGRAÇÃO', 'BÁSICO SEGURANÇA ELETRICIDADE (NR 10)']
  },
  {
    // nomes sem acento e em maiúsculas: a API casa com "Apart Hotel" / "Camareira"
    numero: 2, setor: 'APART HOTEL', atividade: 'Serviços de camareira', funcoes: ['CAMAREIRA'], observacao_epi: 'Boné e protetor solar não são EPI.',
    riscos: [{ categoria: 'biologico', agente: 'Bactérias e fungos', fonte_geradora: 'Roupas de cama' }],
    epis: [{ parte_corpo: 'membros_inferiores', descricao: 'Bota de borracha' }]
  }
];

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');
  ids.A = (await api('POST', '/filiais', { token: tk.admin, body: { nome: 'Campus Exemplo', cnpj: '11222333000181', uf: 'RS', cidade: 'Guaíba', bairro: 'Centro', grau_risco: 2 } })).body.id;
  for (const nome of ['Manutenção', 'Apart Hotel']) await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome } });
  for (const nome of ['Eletricista', 'Encarregado de Elétrica', 'Camareira']) await api('POST', '/funcoes', { token: tk.admin, body: { nome } });
  const r = await api('POST', '/pgrs', {
    token: tk.admin, body: {
      titulo: 'PGR Exemplo', data_inicio: somarDias(HOJE, -1), data_fim: somarMeses(HOJE, 12), filial_ids: [ids.A],
      responsavel_nome: 'Eng. Fulano', responsavel_registro: 'CREA-RS 000000', arquivo: pdf()
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.pgr = r.body.id;
});

after(async () => {
  fs.rmSync(pasta, { recursive: true, force: true });
  await amb?.encerrar();
});

test('planilha: ida e volta preserva grupos, riscos, EPIs e treinamentos, e a API aceita', async () => {
  const arquivo = path.join(pasta, 'ok.xlsx');
  await escreverPlanilha(grupos(), arquivo, { conferencia: [['Teste', 'detalhe']], cadastros: { setores: [['Manutenção', 'filial']], funcoes: [['Eletricista', 'igual']] } });
  const { grupos: lidos } = await lerPlanilha(arquivo);

  assert.equal(lidos.length, 2);
  const [g1, g2] = lidos;
  assert.equal(g1.ordem, 1);
  assert.deepEqual(g1.funcoes, ['Eletricista', 'Encarregado de Elétrica']);
  assert.equal(g1.conclusao_gfip, '01');
  assert.equal(g1.riscos.length, 2);
  assert.equal(g1.riscos[0].categoria, 'fisico');
  assert.equal(g1.riscos[0].probabilidade, 2);
  assert.equal(g1.riscos[1].probabilidade, null);
  assert.deepEqual(g1.epis.map((e) => e.parte_corpo), ['maos', 'corpo']);
  assert.deepEqual(g1.treinamentos.map((t) => t.descricao), ['ORDEM DE SERVIÇO (NR 1) - INTEGRAÇÃO', 'BÁSICO SEGURANÇA ELETRICIDADE (NR 10)']);
  assert.equal(g2.epis[0].parte_corpo, 'membros_inferiores');
  assert.equal(g2.observacao_epi, 'Boné e protetor solar não são EPI.');

  const r = await api('POST', `/pgrs/${ids.pgr}/grupos`, { token: tk.admin, body: { grupos: lidos } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pgr = await api('GET', `/pgrs/${ids.pgr}`, { token: tk.admin });
  assert.equal(pgr.body.grupos.length, 2);
});

test('planilha: leitura lista todos os problemas de uma vez', async () => {
  const arquivo = path.join(pasta, 'ruim.xlsx');
  const gs = grupos();
  gs[1].setor = 'Manutenção';
  gs[1].funcoes = ['ELETRICISTA'];
  await escreverPlanilha(gs, arquivo);

  // estraga uma categoria direto na planilha
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(arquivo);
  wb.getWorksheet('Riscos').getCell('B2').value = 'Inventada';
  wb.getWorksheet('EPIs').getCell('A2').value = 99;
  await wb.xlsx.writeFile(arquivo);

  await assert.rejects(lerPlanilha(arquivo), (e) => {
    assert.equal(e.problemas.length, 3, e.message);
    assert.match(e.message, /categoria "Inventada" inválida/);
    assert.match(e.message, /grupo "99" não existe/);
    assert.match(e.message, /Grupos 1 e 2: "ELETRICISTA" aparece duas vezes/);
    return true;
  });
});
