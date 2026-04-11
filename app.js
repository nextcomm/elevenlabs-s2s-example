const express = require('express');
const app = express();
const {createServer} = require('http');
const {createEndpoint} = require('@jambonz/node-client-ws');
const server = createServer(app);
const makeService = createEndpoint({server});
const logger = require('pino')({level: process.env.LOGLEVEL || 'info'});
const port = process.env.WS_PORT || 3000;

app.locals = {
  ...app.locals,
  logger
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

require('./lib/routes')({logger, makeService});
require('./lib/routes/call-status')({ logger, app });

server.listen(port, () => {
  logger.info(`jambonz websocket server listening at http://localhost:${port}`);
});
