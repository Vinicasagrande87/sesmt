const express = require('express');
const routes = express.Router();

const FilialController = require('./controllers/FilialController');
const PredioController = require('./controllers/PredioController');
const SetorController = require('./controllers/SetorController');
const FuncaoController = require('./controllers/FuncaoController');
const FuncionarioController = require('./controllers/FuncionarioController');
const EpiController = require('./controllers/EpiController');
const EntregaController = require('./controllers/EntregaController');
const AcidenteController = require('./controllers/AcidenteController');
const TreinamentoController = require('./controllers/TreinamentoController');
const CertificadoController = require('./controllers/CertificadoController');
const EstoqueController = require('./controllers/EstoqueController');
const AuthController = require('./controllers/AuthController');
const UsuarioController = require('./controllers/UsuarioController');
const AuditoriaController = require('./controllers/AuditoriaController');
const { autenticar, permitir } = require('./middlewares/auth');

// Quem pode o quê (o filtro por filial é feito dentro de cada controller)
const matriz = permitir('admin');                                   // catálogos, filiais, usuários
const gestao = permitir('admin', 'gestor');                         // cadastros da filial
const operacao = permitir('admin', 'gestor', 'tecnico');            // entregas, estoque, registros
const cadastroPessoal = permitir('admin', 'gestor', 'tecnico', 'saude'); // ver ficha / QR do funcionário

// Rotas públicas
routes.get('/ping', (req, res) => res.json({ message: 'pong' }));
routes.post('/auth/login', AuthController.login);

// Daqui para baixo, tudo exige "Authorization: Bearer <token>".
// Sem perfil explícito = qualquer usuário logado (somente leitura, filtrada pelas suas filiais).
routes.use(autenticar);

routes.get('/auth/me', AuthController.me);

// Usuários e auditoria (matriz)
routes.get('/usuarios', matriz, UsuarioController.index);
routes.post('/usuarios', matriz, UsuarioController.create);
routes.put('/usuarios/:id', matriz, UsuarioController.update);
routes.get('/auditoria', matriz, AuditoriaController.index);

// Estrutura
routes.get('/filiais', FilialController.index);
routes.get('/filiais/:id', FilialController.show);
routes.post('/filiais', matriz, FilialController.create);
routes.put('/filiais/:id', matriz, FilialController.update);

routes.get('/predios', PredioController.index);
routes.post('/predios', gestao, PredioController.create);
routes.put('/predios/:id', gestao, PredioController.update);

routes.get('/setores', SetorController.index);
routes.post('/setores', gestao, SetorController.create);
routes.put('/setores/:id', gestao, SetorController.update);

routes.get('/funcoes', FuncaoController.index);
routes.post('/funcoes', matriz, FuncaoController.create);
routes.put('/funcoes/:id', matriz, FuncaoController.update);

// Funcionários
routes.get('/funcionarios', FuncionarioController.index);
routes.post('/funcionarios', gestao, FuncionarioController.create);
routes.get('/funcionarios/qr/:token', operacao, FuncionarioController.buscarPorToken);
routes.get('/funcionarios/:id', FuncionarioController.show);
routes.put('/funcionarios/:id', gestao, FuncionarioController.update);
routes.get('/funcionarios/:id/lotacoes', FuncionarioController.lotacoes);
routes.get('/funcionarios/:id/qrcode', cadastroPessoal, FuncionarioController.qrcode);

// EPIs (catálogo da matriz), entregas e estoque
routes.get('/epis', EpiController.index);
routes.post('/epis', matriz, EpiController.create);
routes.put('/epis/:id', matriz, EpiController.update);

routes.get('/entregas', EntregaController.index);
routes.post('/entregas', operacao, EntregaController.create);
routes.post('/entregas/qr', operacao, EntregaController.createPorQr);

routes.get('/estoque', EstoqueController.index);
routes.post('/estoque', operacao, EstoqueController.create);

// Treinamentos (catálogo da matriz) e certificados
routes.get('/treinamentos', TreinamentoController.index);
routes.post('/treinamentos', matriz, TreinamentoController.create);
routes.put('/treinamentos/:id', matriz, TreinamentoController.update);

routes.get('/certificados', CertificadoController.index);
routes.post('/certificados', operacao, CertificadoController.create);

// Acidentes
routes.get('/acidentes', AcidenteController.index);
routes.post('/acidentes', operacao, AcidenteController.create);

module.exports = routes;
