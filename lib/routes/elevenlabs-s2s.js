const service = ({logger, makeService}) => {
  const svc = makeService({path: '/elevenlabs-s2s'});

  svc.on('session:new', (session, path) => {
    session.locals = { ...session.locals,
      transcripts: [],
      logger: logger.child({call_sid: session.call_sid})
    };
    session.locals.logger.info({session, path}, `new incoming call: ${session.call_sid}`);

    const agent_id = process.env.ELEVENLABS_AGENT_ID;
    const api_key = process.env.ELEVENLABS_API_KEY;

    // Lê variáveis passadas pelo CampaignManager via env_vars
    const nome = session.env_vars?.nome || '';
    const empresa = session.env_vars?.empresa || '';

    // Monta first_message dinamicamente se tiver nome, senão usa padrão
    const first_message = nome
      ? `[Com entusiasmo] Oláá, falo com ${nome}${empresa ? ` da empresa ${empresa}` : ''}? Meu nome é Olga e estou entrando em contato. Como posso te ajudar?`
      : 'Olá, como posso te ajudar hoje?';

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
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt: 'Você é um assistente virtual em português brasileiro. Seja cordial e prestativo.',
                  },
                  first_message,
                  language: 'pt',
                }
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
