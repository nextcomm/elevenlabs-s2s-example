// Cache em memória: call_sid → { nome, empresa }
const contactCache = new Map();

const service = ({logger, makeService, app}) => {
  const svc = makeService({path: '/elevenlabs-s2s'});

  // Endpoint HTTP para receber dados do contato antes da chamada
  app.post('/contact-data', (req, res) => {
    const { call_sid, nome, empresa } = req.body;
    if (!call_sid) return res.sendStatus(400);
    contactCache.set(call_sid, { nome, empresa });
    logger.info({ call_sid, nome, empresa }, 'contact-data registrado');
    res.sendStatus(200);
  });

  svc.on('session:new', (session, path) => {
    session.locals = { ...session.locals,
      transcripts: [],
      logger: logger.child({call_sid: session.call_sid})
    };
    session.locals.logger.info({session, path}, `new incoming call: ${session.call_sid}`);

    // Usa o agente enviado por chamada (env_vars.agent_id, vindo do CampaignManager/
    // NextVoice). Cai na variável de ambiente fixa só quando a chamada não especifica.
    const agent_id = session.env_vars?.agent_id || process.env.ELEVENLABS_AGENT_ID;
    const api_key = process.env.ELEVENLABS_API_KEY;

    // Busca dados do contato pelo call_sid (registrado pelo CampaignManager)
    const contactData = contactCache.get(session.call_sid) || {};
    const nome = contactData.nome || session.env_vars?.nome || 'cliente';
    const empresa = contactData.empresa || session.env_vars?.empresa || '';

    // Remove do cache após usar
    contactCache.delete(session.call_sid);

    session.locals.logger.info({ nome, empresa }, 'dados do contato para esta chamada');

    session
      .on('/event', onEvent.bind(null, session))
      .on('/toolCall', onToolCall.bind(null, session))
      .on('/final', onFinal.bind(null, session))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));

    if (!agent_id) {
      session.locals.logger.info('missing env ELEVENLABS_AGENT_ID, hanging up');
      session.hangup().send();
    } else {
      session
        .answer()
        .pause({length: 1})
        .llm({
          vendor: 'elevenlabs',
          model: 'eleven_turbo_v2_5',
          auth: {
            agent_id,
            ...(api_key && {api_key})
          },
          actionHook: '/final',
          eventHook: '/event',
          toolHook: '/toolCall',
          llmOptions: {
            input_sample_rate: 16000,
            output_sample_rate: 16000,
            conversation_initiation_client_data: {
              dynamic_variables: {
                nome,
                empresa
              }
            }
          }
        })
        .hangup()
        .send();
    }
  });
};

const onFinal = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got actionHook: ${JSON.stringify(evt)}`);
  if (['server failure', 'server error'].includes(evt.completion_reason)) {
    session.say({text: 'Desculpe, ocorreu um erro. Tente novamente.'});
    session.hangup();
  }
  session.reply();
};

const onEvent = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got eventHook: ${JSON.stringify(evt)}`);
};

const onToolCall = async(session, evt) => {
  const {logger} = session.locals;
  logger.info({evt}, 'got toolHook');
};

const onClose = (session, code, reason) => {
  const {logger} = session.locals;
  logger.info({code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

module.exports = service;
