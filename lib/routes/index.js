module.exports = ({logger, makeService, app}) => {
  require('./elevenlabs-s2s')({logger, makeService, app});
};
