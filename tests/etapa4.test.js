// Etapa 4: ASOs (NR-7) — lançamento com o PDF da clínica, vencimento pela periodicidade da função,
// sigilo dos dados de saúde (LGPD), anulação, pendências e exame demissional.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const CONTEUDO_PDF = Buffer.from('%PDF-1.4\n% ASO da clinica\n%%EOF');
const pdf = () => 'data:application/pdf;base64,' + CONTEUDO_PDF.toString('base64');

async function baixar(url, token) {
  const r = await fetch(amb.base + url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, tipo: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
}

const aso = (funcionario, extra = {}) => ({
  funcionario_id: funcionario, tipo: 'periodico', data_exame: HOJE, resultado: 'apto',
  medico_nome: 'Dra. Paula Exemplo', medico_crm: '12345', medico_uf: 'RS', clinica: 'Clínica Exemplo',
  riscos: 'Ruído; eletricidade', exames_complementares: 'Audiometria', arquivo: pdf(), ...extra
});

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');

  const filial = async (nome, cnpj, extra = {}) => (await api('POST', '/filiais', {
    token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro', ...extra }
  })).body.id;
  ids.A = await filial('Campus Guaíba', '11222333000181', { grau_risco: 2 });
  ids.B = await filial('Colégio Exemplo', '11222333000262');
  ids.eletricista = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista', periodicidade_aso_meses: 6 } })).body.id;
  ids.auxiliar = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Auxiliar' } })).body.id;
  ids.setorA = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;

  for (const [nome, perfil, filiais] of [['saudeA', 'saude', [ids.A]], ['saudeB', 'saude', [ids.B]], ['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }

  const cpfs = ['52998224725', '12345678909', '11144477735', '39053344705', '15350946056', '86288366757', '71428793860', '04163245170'];
  const pessoas = ['ana', 'bruno', 'carla', 'diego', 'elisa', 'fabio', 'sergio', 'gil'];
  for (const [i, chave] of pessoas.entries()) {
    const r = await api('POST', '/funcionarios', {
      token: tk.gestorA,
      body: { matricula: String(2001 + i), nome: chave[0].toUpperCase() + chave.slice(1), cpf: cpfs[i], data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setorA, funcao_id: chave === 'ana' ? ids.eletricista : ids.auxiliar }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[chave] = r.body.id;
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('periodicidade na função e grau de risco na filial são validados', async () => {
  assert.equal((await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'X', periodicidade_aso_meses: 0 } })).status, 400);
  assert.equal((await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'X', periodicidade_aso_meses: 25 } })).status, 400);
  assert.equal((await api('PUT', `/filiais/${ids.B}`, { token: tk.admin, body: { grau_risco: 5 } })).status, 400);
  const aux = (await api('GET', '/funcoes', { token: tk.admin })).body.find((f) => f.id === ids.auxiliar);
  assert.equal(aux.periodicidade_aso_meses, 12, 'padrão anual');
});

test('lançar ASO: só saude/admin, na sua filial, com validações', async () => {
  assert.equal((await api('POST', '/asos', { token: tk.tecA, body: aso(ids.ana) })).status, 403);
  assert.equal((await api('POST', '/asos', { token: tk.gestorA, body: aso(ids.ana) })).status, 403);
  assert.equal((await api('POST', '/asos', { token: tk.saudeB, body: aso(ids.ana) })).status, 404, 'funcionário de outra filial');
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { arquivo: undefined }) })).status, 400);
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { arquivo: 'data:text/plain;base64,' + Buffer.from('oi').toString('base64') }) })).status, 400);
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { tipo: 'outro' }) })).status, 400);
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { data_exame: somarDias(HOJE, 1) }) })).status, 400);
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { resultado: 'apto_restricao' }) })).status, 400, 'restrição sem descrição');
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { tipo: 'demissional', data_proximo_exame: somarMeses(HOJE, 6) }) })).status, 400);
  assert.equal((await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { data_proximo_exame: HOJE }) })).status, 400);

  const r = await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.ana, { tipo: 'admissional' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data_vencimento, somarMeses(HOJE, 6), 'periodicidade da função (6 meses)');
  assert.equal(r.body.filial_id, ids.A);
  ids.asoAna = r.body.id;
  ids.arquivoAna = r.body.arquivo_id;

  const inapto = await api('POST', '/asos', { token: tk.admin, body: aso(ids.diego, { resultado: 'inapto' }) });
  assert.equal(inapto.status, 201);
  assert.equal(inapto.body.data_vencimento, null, 'inapto não tem vencimento');
});

test('LGPD: gestor vê só apto/inapto e vencimento; PDF só para saude/admin', async () => {
  const doGestor = (await api('GET', `/asos?funcionario_id=${ids.ana}`, { token: tk.gestorA })).body;
  assert.equal(doGestor.length, 1);
  assert.equal(doGestor[0].resultado, 'apto');
  assert.equal(doGestor[0].data_vencimento, somarMeses(HOJE, 6));
  for (const campo of ['medico_nome', 'medico_crm', 'riscos', 'exames_complementares', 'restricoes', 'arquivo_id', 'clinica']) {
    assert.equal(campo in doGestor[0], false, `gestor não deve ver ${campo}`);
  }
  const daSaude = (await api('GET', `/asos?funcionario_id=${ids.ana}`, { token: tk.saudeA })).body;
  assert.equal(daSaude[0].medico_crm, '12345');
  assert.equal(daSaude[0].riscos, 'Ruído; eletricidade');

  assert.deepEqual((await api('GET', '/asos', { token: tk.tecB })).body, [], 'outra filial não vê nada');

  assert.equal((await baixar(`/asos/${ids.asoAna}/arquivo`, tk.gestorA)).status, 403);
  assert.equal((await baixar(`/asos/${ids.asoAna}/arquivo`, tk.saudeB)).status, 404);
  const arq = await baixar(`/asos/${ids.asoAna}/arquivo`, tk.saudeA);
  assert.equal(arq.status, 200);
  assert.equal(arq.tipo, 'application/pdf');
  assert.deepEqual(arq.bytes, CONTEUDO_PDF);

  // A rota genérica de arquivos também não pode abrir o ASO para quem não é da saúde
  assert.equal((await baixar(`/arquivos/${ids.arquivoAna}`, tk.gestorA)).status, 404);
  assert.equal((await baixar(`/arquivos/${ids.arquivoAna}`, tk.tecA)).status, 404);
  assert.equal((await baixar(`/arquivos/${ids.arquivoAna}`, tk.saudeA)).status, 200);

  const acessos = await amb.knex('auditoria').where({ acao: 'baixar_aso', registro_id: ids.asoAna });
  assert.equal(acessos.length, 1, 'download do ASO fica registrado');
});

test('pendências: faltando, inapto, vencido, vencendo, em dia e restrição', async () => {
  const lancar = async (f, extra) => {
    const r = await api('POST', '/asos', { token: tk.saudeA, body: aso(f, extra) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  await lancar(ids.bruno, { data_exame: somarMeses(HOJE, -13) });
  await lancar(ids.carla, { data_exame: somarMeses(HOJE, -11), data_proximo_exame: somarDias(HOJE, 10) });
  await lancar(ids.fabio, { resultado: 'apto_restricao', restricoes: 'Não trabalhar em altura' });
  await lancar(ids.sergio, { data_exame: somarDias(HOJE, -200) });
  await lancar(ids.gil, { data_exame: somarDias(HOJE, -100) });

  const p = await api('GET', '/asos/pendencias?todas=true', { token: tk.gestorA });
  assert.equal(p.status, 200);
  const sit = Object.fromEntries(p.body.itens.map((i) => [i.funcionario, i.situacao]));
  assert.deepEqual(sit, { Ana: 'em_dia', Bruno: 'vencido', Carla: 'vencendo', Diego: 'inapto', Elisa: 'faltando', Fabio: 'em_dia', Sergio: 'em_dia', Gil: 'em_dia' });
  assert.equal(p.body.itens.find((i) => i.funcionario === 'Fabio').com_restricao, true);
  assert.equal(p.body.itens[0].funcionario, 'Elisa', 'ordem: faltando primeiro');

  const so = await api('GET', '/asos/pendencias', { token: tk.gestorA });
  assert.deepEqual(so.body.resumo, { faltando: 1, inapto: 1, vencido: 1, vencendo: 1, demissional_pendente: 0, em_dia: 0 });
  assert.equal((await api('GET', '/asos/pendencias?situacao=xx', { token: tk.gestorA })).status, 400);
  assert.deepEqual((await api('GET', '/asos/pendencias', { token: tk.tecB })).body.itens, []);
});

test('o ASO mais recente manda: novo periódico inapto derruba quem estava em dia', async () => {
  await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.fabio, { resultado: 'inapto' }) });
  const p = await api('GET', `/asos/pendencias?funcionario_id=${ids.fabio}`, { token: tk.saudeA });
  assert.equal(p.body.itens[0].situacao, 'inapto');
});

test('anulação: não apaga, volta a pendência e não anula duas vezes', async () => {
  assert.equal((await api('POST', `/asos/${ids.asoAna}/anular`, { token: tk.gestorA, body: { motivo: 'digitado errado' } })).status, 403);
  assert.equal((await api('POST', `/asos/${ids.asoAna}/anular`, { token: tk.saudeA, body: { motivo: 'x' } })).status, 400);
  assert.equal((await api('POST', `/asos/${ids.asoAna}/anular`, { token: tk.saudeA, body: { motivo: 'Data do exame digitada errada' } })).status, 201);
  assert.equal((await api('POST', `/asos/${ids.asoAna}/anular`, { token: tk.saudeA, body: { motivo: 'Data do exame digitada errada' } })).status, 409);

  const p = await api('GET', `/asos/pendencias?funcionario_id=${ids.ana}`, { token: tk.saudeA });
  assert.equal(p.body.itens[0].situacao, 'faltando');
  assert.deepEqual((await api('GET', `/asos?funcionario_id=${ids.ana}`, { token: tk.saudeA })).body, []);
  const todos = (await api('GET', `/asos?funcionario_id=${ids.ana}&incluir_anulados=true`, { token: tk.saudeA })).body;
  assert.equal(todos.length, 1);
  assert.equal(todos[0].anulado, true);
  assert.equal(todos[0].anulacao_motivo, 'Data do exame digitada errada');
  assert.ok(await amb.knex('asos').where({ id: ids.asoAna }).first(), 'registro continua no banco');
});

test('demissional: pendente após desligamento, com dispensa pelo exame recente (grau de risco)', async () => {
  for (const f of [ids.sergio, ids.gil]) {
    const r = await api('PUT', `/funcionarios/${f}`, { token: tk.gestorA, body: { status: 'Desligado', data_demissao: HOJE } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  // Grau 2: dispensa até 135 dias. Sérgio (200 dias) precisa; Gil (100 dias) está dispensado.
  let p = await api('GET', '/asos/pendencias?situacao=demissional_pendente', { token: tk.gestorA });
  assert.deepEqual(p.body.itens.map((i) => i.funcionario), ['Sergio']);
  assert.equal(p.body.itens[0].vencimento, somarDias(HOJE, 10), 'prazo de 10 dias');

  // Grau 3: dispensa cai para 90 dias e o Gil passa a precisar
  await api('PUT', `/filiais/${ids.A}`, { token: tk.admin, body: { grau_risco: 3 } });
  p = await api('GET', '/asos/pendencias?situacao=demissional_pendente', { token: tk.gestorA });
  assert.deepEqual(p.body.itens.map((i) => i.funcionario).sort(), ['Gil', 'Sergio']);

  const dem = await api('POST', '/asos', { token: tk.saudeA, body: aso(ids.sergio, { tipo: 'demissional' }) });
  assert.equal(dem.status, 201, 'demissional aceito para funcionário desligado');
  assert.equal(dem.body.data_vencimento, null);
  p = await api('GET', '/asos/pendencias?situacao=demissional_pendente', { token: tk.gestorA });
  assert.deepEqual(p.body.itens.map((i) => i.funcionario), ['Gil']);
});
