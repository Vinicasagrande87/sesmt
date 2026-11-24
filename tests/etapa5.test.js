// Etapa 5: PGR por filial (grupos de exposição), publicação com OS "fotografada",
// ciência por QR + PIN ou manual, pendências, revisão do PGR, PDF e verificação pública.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');
const { nivelDoRisco } = require('../src/services/pgr');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% PGR de exemplo\n%%EOF').toString('base64');

async function baixar(url, token) {
  const r = await fetch(amb.base + url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, tipo: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
}

const dadosPgr = (extra = {}) => ({
  titulo: 'PGR Campus Exemplo', data_inicio: somarDias(HOJE, -30), data_fim: somarMeses(HOJE, 11),
  filial_ids: [ids.A, ids.B], responsavel_nome: 'Eng. Fulano de Tal', responsavel_registro: 'CREA-RS 000000',
  responsavel_titulacao: 'Engenheiro de Segurança do Trabalho', arquivo: pdf(), ...extra
});

const grupoManutencao = () => ({
  setor: 'Manutenção', atividade: 'Atividades em eletricidade', funcoes: ['Eletricista'],
  descricao_atividades: 'Manutenção da rede elétrica, troca de lâmpadas e reatores.',
  medidas_controle: 'Manter o uso correto dos EPIs. Bloqueio e etiquetagem antes de intervir.',
  conclusao_gfip: '01', unidade_fisica: 'Prédio 29',
  riscos: [
    { categoria: 'fisico', agente: 'Ruído contínuo', referencia: 'NR 15 (anexo 1)', fonte_geradora: 'Máquinas de manutenção', medicao: '62,65 dB(A)', probabilidade: 2, efeito: 2 },
    { categoria: 'acidente', agente: 'Trabalho em altura', referencia: 'NR 35', exposicao: 'eventual', probabilidade: 4, efeito: 5 }
  ],
  epis: [
    { parte_corpo: 'maos', descricao: 'Luva para agentes mecânicos', epi_id: ids.luva },
    { parte_corpo: 'corpo', descricao: 'Cinto para trabalho em altura' }
  ],
  treinamentos: ['ORDEM DE SERVIÇO (NR 1) - INTEGRAÇÃO', { descricao: 'BÁSICO SEGURANÇA ELETRICIDADE (NR 10)', treinamento_id: ids.nr10 }]
});

const grupoCamareira = () => ({
  setor: 'Apart Hotel', atividade: 'Executar serviços de camareira', funcoes: ['Aux Serv Gerais'],
  riscos: [{ categoria: 'biologico', agente: 'Bactérias e fungos', fonte_geradora: 'Contato eventual com secreção corpórea em roupas' }],
  epis: [{ parte_corpo: 'maos', descricao: 'Luva PVC' }]
});

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');

  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro', grau_risco: 2 } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Hospital Escola', '11222333000262');
  ids.C = await filial('Colégio Exemplo', '11444777000161');
  const setor = async (filial_id, nome) => (await api('POST', '/setores', { token: tk.admin, body: { filial_id, nome } })).body.id;
  ids.manutencao = await setor(ids.A, 'Manutenção');
  ids.apart = await setor(ids.A, 'Apart Hotel');
  ids.limpeza = await setor(ids.A, 'Limpeza');
  ids.labB = await setor(ids.B, 'Laboratório');
  const funcao = async (nome) => (await api('POST', '/funcoes', { token: tk.admin, body: { nome } })).body.id;
  ids.eletricista = await funcao('Eletricista');
  ids.auxSG = await funcao('Aux Serv Gerais');
  ids.tecLab = await funcao('Técnico de Laboratório');

  const luva = await api('POST', '/epis', { token: tk.admin, body: { nome: 'Luva de vaqueta', validade_dias: 60, ca: { numero: 'CA 11.111', validade: '2099-12-31' } } });
  ids.luva = luva.body.id;
  ids.luvaItem = luva.body.itens[0].id;
  ids.nr10 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Segurança em eletricidade', nr_referencia: 'NR-10', carga_horaria: 40, validade_meses: 24 } })).body.id;

  for (const [nome, perfil, filiais] of [['tecAB', 'tecnico', [ids.A, ids.B]], ['tecA', 'tecnico', [ids.A]], ['gestorA', 'gestor', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecC', 'tecnico', [ids.C]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }

  const pessoa = async (matricula, nome, cpf, setor_id, funcao_id, filial_id = ids.A) => {
    const r = await api('POST', '/funcionarios', {
      token: tk.admin, body: { matricula, nome, cpf, data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id, setor_id, funcao_id }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.id, qr: r.body.qr_token };
  };
  ids.ana = await pessoa('3001', 'Ana Eletricista', '52998224725', ids.manutencao, ids.eletricista);
  ids.bia = await pessoa('3002', 'Bia Camareira', '12345678909', ids.apart, ids.auxSG);
  ids.caio = await pessoa('3003', 'Caio da Limpeza', '11144477735', ids.limpeza, ids.auxSG);
  await api('POST', `/funcionarios/qr/${ids.ana.qr}/pin`, { token: tk.tecA, body: { pin: '4821' } });
});

after(async () => { if (amb) await amb.encerrar(); });

test('matriz AIHA do PGR', () => {
  assert.equal(nivelDoRisco(1, 1), 'trivial');
  assert.equal(nivelDoRisco(5, 1), 'baixo');
  assert.equal(nivelDoRisco(2, 4), 'moderado');
  assert.equal(nivelDoRisco(4, 5), 'alto');
  assert.equal(nivelDoRisco(5, 5), 'muito_alto');
  assert.equal(nivelDoRisco(null, null), null);
  assert.throws(() => nivelDoRisco(3, null));
  assert.throws(() => nivelDoRisco(6, 1));
});

test('cadastro do PGR: filial cadastra, cobrindo um ou mais CNPJs', async () => {
  assert.equal((await api('POST', '/pgrs', { token: tk.consultaA, body: dadosPgr() })).status, 403);
  assert.equal((await api('POST', '/pgrs', { token: tk.tecA, body: dadosPgr() })).status, 403, 'tecA não atua na filial B');
  assert.equal((await api('POST', '/pgrs', { token: tk.tecAB, body: dadosPgr({ arquivo: undefined }) })).status, 400);
  assert.equal((await api('POST', '/pgrs', { token: tk.tecAB, body: dadosPgr({ data_fim: '2000-01-01' }) })).status, 400);

  const r = await api('POST', '/pgrs', { token: tk.tecAB, body: dadosPgr() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'rascunho');
  assert.deepEqual(r.body.filial_ids, [ids.A, ids.B]);
  ids.pgr = r.body.id;

  assert.deepEqual((await api('GET', '/pgrs', { token: tk.tecC })).body, [], 'outra filial não vê');
  assert.equal((await api('GET', `/pgrs/${ids.pgr}`, { token: tk.tecC })).status, 404);
  assert.equal((await api('GET', '/pgrs', { token: tk.consultaA })).body.length, 1, 'quem atua em uma das filiais consulta');
  assert.equal((await api('PUT', `/pgrs/${ids.pgr}`, { token: tk.tecA, body: { titulo: 'x' } })).status, 403, 'alterar exige todas as filiais');
});

test('grupos de exposição: setor e funções por nome, validações e importação em lote', async () => {
  const url = `/pgrs/${ids.pgr}/grupos`;
  assert.equal((await api('POST', url, { token: tk.tecAB, body: { ...grupoManutencao(), setor: 'Inexistente' } })).status, 400);
  const semFuncao = await api('POST', url, { token: tk.tecAB, body: { ...grupoManutencao(), funcoes: ['Eletricista', 'Astronauta'] } });
  assert.equal(semFuncao.status, 400);
  assert.deepEqual(semFuncao.body.funcoes, ['Astronauta'], 'lista as funções que faltam no catálogo');
  assert.equal((await api('POST', url, { token: tk.tecAB, body: { ...grupoManutencao(), riscos: [{ categoria: 'mágico', agente: 'x' }] } })).status, 400);
  assert.equal((await api('POST', url, { token: tk.tecAB, body: { ...grupoManutencao(), epis: [{ parte_corpo: 'joelho', descricao: 'x' }] } })).status, 400);

  const g = await api('POST', url, { token: tk.tecAB, body: grupoManutencao() });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.setor, 'Manutenção');
  assert.deepEqual(g.body.riscos.map((r) => r.nivel), ['baixo', 'alto'], 'nível calculado pela matriz');
  assert.equal(g.body.epis[0].epi_catalogo, 'Luva de vaqueta');
  ids.grupoManut = g.body.id;

  const repetido = await api('POST', url, { token: tk.tecAB, body: { ...grupoCamareira(), setor: 'Manutenção', funcoes: ['Eletricista'] } });
  assert.equal(repetido.status, 409, 'mesmo setor + função em dois grupos');

  // Lote: tudo ou nada
  const loteRuim = await api('POST', url, { token: tk.tecAB, body: { grupos: [grupoCamareira(), { ...grupoCamareira(), setor: 'Nada' }] } });
  assert.equal(loteRuim.status, 400);
  assert.match(loteRuim.body.error, /^Grupo 2/);
  assert.equal((await amb.knex('pgr_grupos').where({ pgr_id: ids.pgr })).length, 1, 'nada do lote ruim foi gravado');

  const lote = await api('POST', url, {
    token: tk.tecAB,
    body: { grupos: [grupoCamareira(), { setor: 'Laboratório', atividade: 'Laboratório químico', funcoes: ['Técnico de Laboratório'], riscos: [{ categoria: 'quimico', agente: 'Formaldeído', medicao: '4,59 ppm' }] }] }
  });
  assert.equal(lote.status, 201, JSON.stringify(lote.body));
  assert.equal(lote.body.length, 2);
  ids.grupoCamareira = lote.body[0].id;

  const alterado = await api('PUT', `/pgr-grupos/${ids.grupoCamareira}`, { token: tk.tecAB, body: { ...grupoCamareira(), medidas_controle: 'Usar luva PVC ao recolher roupas.' } });
  assert.equal(alterado.status, 200);
  assert.equal(alterado.body.medidas_controle, 'Usar luva PVC ao recolher roupas.');
});

test('antes de publicar: ninguém tem OS e a ciência é recusada', async () => {
  const p = await api('GET', '/ordens-servico/pendencias', { token: tk.gestorA });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.resumo, { sem_pgr: 3, sem_grupo: 0, ciencia_pendente: 0, em_dia: 0 });
  assert.equal((await api('POST', '/ordens-servico/ciencia', { token: tk.tecA, body: { token: ids.ana.qr, pin: '4821' } })).status, 409);
});

test('publicação: congela o PGR e gera uma OS por grupo com hash do conteúdo', async () => {
  assert.equal((await api('POST', `/pgrs/${ids.pgr}/publicar`, { token: tk.tecA })).status, 403);
  const pub = await api('POST', `/pgrs/${ids.pgr}/publicar`, { token: tk.tecAB });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.status, 'vigente');
  assert.equal(pub.body.ordens_servico.length, 3);
  assert.ok(pub.body.ordens_servico.every((o) => /^[0-9a-f]{64}$/.test(o.hash)));

  assert.equal((await api('PUT', `/pgrs/${ids.pgr}`, { token: tk.tecAB, body: { titulo: 'x' } })).status, 409);
  assert.equal((await api('PUT', `/pgr-grupos/${ids.grupoManut}`, { token: tk.tecAB, body: grupoManutencao() })).status, 409);
  assert.equal((await api('DELETE', `/pgr-grupos/${ids.grupoManut}`, { token: tk.tecAB })).status, 409);
  assert.equal((await api('POST', `/pgrs/${ids.pgr}/publicar`, { token: tk.tecAB })).status, 409);
});

test('OS do funcionário: localizada por setor + função; Caio (Limpeza) fica sem grupo', async () => {
  const ana = await api('GET', `/funcionarios/${ids.ana.id}/ordem-servico`, { token: tk.consultaA });
  assert.equal(ana.status, 200);
  assert.equal(ana.body.situacao, 'ciencia_pendente');
  assert.equal(ana.body.ordem_servico.setor, 'Manutenção');
  assert.deepEqual(ana.body.ordem_servico.riscos.map((r) => r.nivel), ['Baixo', 'Alto']);
  assert.ok(ana.body.ordem_servico.obrigacoes.length > 0);
  assert.deepEqual(ana.body.epis_nunca_entregues, ['Mãos: Luva para agentes mecânicos']);
  ids.osAna = ana.body.ordem_servico.id;

  const bia = await api('GET', `/funcionarios/${ids.bia.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(bia.body.ordem_servico.atividade, 'Executar serviços de camareira', 'mesma função, OS do setor dela');
  ids.osBia = bia.body.ordem_servico.id;

  const caio = await api('GET', `/funcionarios/${ids.caio.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(caio.body.situacao, 'sem_grupo');
});

test('ciência por QR + PIN: registra uma vez, com código verificável', async () => {
  assert.equal((await api('POST', '/ordens-servico/ciencia', { token: tk.tecA, body: { token: ids.ana.qr, pin: '0000' } })).status, 422);
  assert.equal((await api('POST', '/ordens-servico/ciencia', { token: tk.tecC, body: { token: ids.ana.qr, pin: '4821' } })).status, 404);
  const r = await api('POST', '/ordens-servico/ciencia', { token: tk.tecA, body: { token: ids.ana.qr, pin: '4821' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ordem_servico_id, ids.osAna);
  ids.cienciaAna = r.body;
  assert.equal((await api('POST', '/ordens-servico/ciencia', { token: tk.tecA, body: { token: ids.ana.qr, pin: '4821' } })).status, 409, 'não assina duas vezes');

  const v = await api('GET', `/verificar/${r.body.codigo_verificacao}`);
  assert.equal(v.status, 200);
  assert.equal(v.body.tipo, 'ciencia_ordem_servico');
  assert.equal(v.body.funcionario, 'A. E.');
  assert.equal(v.body.setor, 'Manutenção');
  assert.match(v.body.hash_conteudo, /^[0-9a-f]{64}$/);

  const ana = await api('GET', `/funcionarios/${ids.ana.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(ana.body.situacao, 'em_dia');
});

test('ciência manual (OS em papel): só gestão, com justificativa, só da OS vigente', async () => {
  const body = { funcionario_id: ids.bia.id, data_ciencia: HOJE, observacao: 'OS assinada em papel na integração' };
  assert.equal((await api('POST', `/ordens-servico/${ids.osBia}/ciencias/manual`, { token: tk.tecA, body })).status, 403);
  assert.equal((await api('POST', `/ordens-servico/${ids.osBia}/ciencias/manual`, { token: tk.gestorA, body: { ...body, observacao: 'curta' } })).status, 400);
  assert.equal((await api('POST', `/ordens-servico/${ids.osAna}/ciencias/manual`, { token: tk.gestorA, body })).status, 409, 'OS de outro grupo');
  const r = await api('POST', `/ordens-servico/${ids.osBia}/ciencias/manual`, { token: tk.gestorA, body: { ...body, arquivo: pdf() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.cienciaBia = r.body.id;
});

test('pendências: sem grupo, em dia e EPI exigido nunca entregue', async () => {
  const p = await api('GET', '/ordens-servico/pendencias?todas=true', { token: tk.gestorA });
  const sit = Object.fromEntries(p.body.itens.map((i) => [i.funcionario, i.situacao]));
  assert.deepEqual(sit, { 'Ana Eletricista': 'em_dia', 'Bia Camareira': 'em_dia', 'Caio da Limpeza': 'sem_grupo' });

  // Ana está em dia com a ciência, mas nunca recebeu a luva exigida pela OS: continua na lista de pendências
  let padrao = await api('GET', '/ordens-servico/pendencias', { token: tk.gestorA });
  assert.deepEqual(padrao.body.itens.map((i) => i.funcionario).sort(), ['Ana Eletricista', 'Caio da Limpeza']);

  await api('POST', '/estoque/entradas', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaItem, quantidade: 5, valor_unitario: 10 } });
  const entrega = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.ana.qr, pin: '4821', item_id: ids.luvaItem } });
  assert.equal(entrega.status, 201, JSON.stringify(entrega.body));
  padrao = await api('GET', '/ordens-servico/pendencias', { token: tk.gestorA });
  assert.deepEqual(padrao.body.itens.map((i) => i.funcionario), ['Caio da Limpeza']);
});

test('anulação da ciência: volta a pendente e pode assinar de novo', async () => {
  assert.equal((await api('POST', `/os-ciencias/${ids.cienciaBia}/anular`, { token: tk.tecA, body: { motivo: 'lançada na pessoa errada' } })).status, 403);
  assert.equal((await api('POST', `/os-ciencias/${ids.cienciaBia}/anular`, { token: tk.gestorA, body: { motivo: 'lançada na pessoa errada' } })).status, 201);
  assert.equal((await api('POST', `/os-ciencias/${ids.cienciaBia}/anular`, { token: tk.gestorA, body: { motivo: 'lançada na pessoa errada' } })).status, 409);
  const bia = await api('GET', `/funcionarios/${ids.bia.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(bia.body.situacao, 'ciencia_pendente');
  assert.equal(bia.body.historico[0].anulada, true);
});

test('PDF da OS: em branco e personalizado com a ciência', async () => {
  const branco = await baixar(`/ordens-servico/${ids.osAna}/pdf`, tk.consultaA);
  assert.equal(branco.status, 200);
  assert.equal(branco.tipo, 'application/pdf');
  assert.equal(branco.bytes.subarray(0, 4).toString(), '%PDF');
  const pessoal = await baixar(`/ordens-servico/${ids.osAna}/pdf?funcionario_id=${ids.ana.id}`, tk.gestorA);
  assert.equal(pessoal.status, 200);
  assert.ok(pessoal.bytes.length > 1000);
  assert.equal((await baixar(`/ordens-servico/${ids.osAna}/pdf`, tk.tecC)).status, 404);
});

test('revisão: novo rascunho copiado; ao publicar, substitui o anterior e pede nova ciência', async () => {
  const rev = await api('POST', `/pgrs/${ids.pgr}/revisar`, { token: tk.tecAB });
  assert.equal(rev.status, 201, JSON.stringify(rev.body));
  assert.equal(rev.body.status, 'rascunho');
  assert.equal(rev.body.grupos, 3);
  ids.pgr2 = rev.body.id;

  const completo = (await api('GET', `/pgrs/${ids.pgr2}`, { token: tk.tecAB })).body;
  const manut = completo.grupos.find((g) => g.setor === 'Manutenção');
  assert.deepEqual(manut.riscos.map((r) => r.nivel), ['baixo', 'alto'], 'riscos copiados');

  // Agora a Limpeza entra no PGR
  assert.equal((await api('POST', `/pgrs/${ids.pgr2}/grupos`, { token: tk.tecAB, body: { ...grupoCamareira(), setor: 'Limpeza', atividade: 'Higienização de banheiros' } })).status, 201);
  const pub = await api('POST', `/pgrs/${ids.pgr2}/publicar`, { token: tk.tecAB });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual(pub.body.substituiu, [ids.pgr]);
  assert.deepEqual(pub.body.filiais_sem_pgr, []);
  assert.equal((await api('GET', `/pgrs/${ids.pgr}`, { token: tk.tecAB })).body.status, 'substituido');

  const ana = await api('GET', `/funcionarios/${ids.ana.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(ana.body.situacao, 'ciencia_pendente', 'nova versão da OS exige nova ciência');
  assert.notEqual(ana.body.ordem_servico.id, ids.osAna);
  assert.equal(ana.body.historico.length, 1, 'ciência da versão anterior continua no histórico');
  const caio = await api('GET', `/funcionarios/${ids.caio.id}/ordem-servico`, { token: tk.gestorA });
  assert.equal(caio.body.situacao, 'ciencia_pendente');

  // A ciência antiga continua verificável
  assert.equal((await api('GET', `/verificar/${ids.cienciaAna.codigo_verificacao}`)).status, 200);
});
