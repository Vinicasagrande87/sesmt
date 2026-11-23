const express = require('express');
const routes = express.Router();

const FuncionarioController = require('./controllers/FuncionarioController');
const EpiController = require('./controllers/EpiController');
const EntregaController = require('./controllers/EntregaController');
const AcidenteController = require('./controllers/AcidenteController');
const TreinamentoController = require('./controllers/TreinamentoController');
const CertificadoController = require('./controllers/CertificadoController');
const EstoqueController = require('./controllers/EstoqueController');
const AuthController = require('./controllers/AuthController');
const UsuarioController = require('./controllers/UsuarioController');
const { autenticar, exigirPerfil } = require('./middlewares/auth');

const somenteAdmin = exigirPerfil('admin');

// Rotas públicas
routes.get('/ping', (req, res) => res.json({ message: 'pong' }));
routes.post('/auth/login', AuthController.login);

// Daqui para baixo, tudo exige "Authorization: Bearer <token>"
routes.use(autenticar);

routes.get('/auth/me', AuthController.me);
routes.get('/usuarios', somenteAdmin, UsuarioController.index);
routes.post('/usuarios', somenteAdmin, UsuarioController.create);

// Rotas existentes
routes.get('/funcionarios', FuncionarioController.index);
routes.post('/funcionarios', FuncionarioController.create);
routes.delete('/funcionarios/:id', somenteAdmin, FuncionarioController.delete);
routes.get('/funcionarios/qr/:token', FuncionarioController.buscarPorToken);
routes.get('/funcionarios/:id/qrcode', FuncionarioController.qrcode);
routes.get('/epis', EpiController.index);
routes.post('/epis', EpiController.create);
routes.delete('/epis/:id', somenteAdmin, EpiController.delete);
routes.get('/entregas', EntregaController.index);
routes.post('/entregas', EntregaController.create);
routes.post('/entregas/qr', EntregaController.createPorQr);

// Novas Rotas
routes.get('/acidentes', AcidenteController.index);
routes.post('/acidentes', AcidenteController.create);

routes.get('/treinamentos', TreinamentoController.index);
routes.post('/treinamentos', TreinamentoController.create);

routes.get('/certificados', CertificadoController.index);
routes.post('/certificados', CertificadoController.create);

routes.get('/estoque', EstoqueController.index);
routes.post('/estoque', EstoqueController.create);

module.exports = routes;