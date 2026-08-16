const { loadAgentPool } = require('./pool');
const ledger = require('../core/ledger');
const { loadConfigConstitution } = require('../core/constitutionStore');

const defaultPrompt = 'Propose a new action for the network.';

const getConstitutionRules = (constitution) => {
  if (!constitution || typeof constitution !== 'object') return {};

  const ruleSources = [
    constitution.rules,
    constitution.policy,
    constitution.constitution,
    constitution.config,
  ].filter((value) => value && typeof value === 'object');

  return ruleSources.reduce((acc, source) => ({ ...acc, ...source }), {});
};

const chooseAgent = (agents, role) => {
  return agents.find((agent) => agent.role === role) || agents.find((agent) => agent.role && agent.role.includes(role)) || agents[0] || null;
};

const resolveCycleAgents = (agents, constitution) => {
  const rules = getConstitutionRules(constitution);
  const orderedRoles = Array.isArray(rules.role_order)
    ? rules.role_order
    : ['initiator', 'respondent', 'guardian', 'reviewer'];

  const initiator = orderedRoles
    .map((role) => chooseAgent(agents, role))
    .find(Boolean) || chooseAgent(agents, 'initiator') || agents[0] || null;

  const respondent = orderedRoles
    .map((role) => chooseAgent(agents, role))
    .find((agent) => agent && agent.id !== initiator?.id) || chooseAgent(agents, 'respondent') || initiator;

  return { initiator, respondent, rules };
};

const makeContent = (stage, prompt, initiator, respondent) => {
  switch (stage) {
    case 'initiator_proposal':
      return `${initiator.label} (${initiator.id}) proposes: ${prompt}`;
    case 'respondent_response':
      return `${respondent.label} (${respondent.id}) responds to ${initiator.label}: I reviewed the proposal and suggest a refinement that improves resilience and clarity.`;
    case 'synthesis':
      return `Synthesis by the board: we accept the proposal with the following summary and next step. ${respondent.label}'s refinement has been incorporated.`;
    default:
      return `${stage}: ${prompt}`;
  }
};

const simulateDeliberationCycle = async (opts = {}) => {
  const prompt = opts.prompt || defaultPrompt;
  const constitution = opts.constitution || (await loadConfigConstitution().catch(() => null));
  const agents = loadAgentPool(constitution);
  const { initiator, respondent, rules } = resolveCycleAgents(agents, constitution);

  if (!initiator || !respondent) {
    throw new Error('Unable to select cycle agents from pool.');
  }

  const allowedStages = Array.isArray(rules.allowed_stages) && rules.allowed_stages.length > 0
    ? rules.allowed_stages
    : ['initiator_proposal', 'respondent_response', 'synthesis'];

  const stages = [
    { record_type: 'initiator_proposal', author: initiator, prompt },
    { record_type: 'respondent_response', author: respondent, prompt },
    { record_type: 'synthesis', author: respondent, prompt },
  ].filter((stage) => allowedStages.includes(stage.record_type));

  const entries = [];
  for (const stage of stages) {
    const content_plain = makeContent(stage.record_type, prompt, initiator, respondent);
    const entry = await ledger.appendRecord({ record_type: stage.record_type, content_plain });
    entries.push(entry);
  }

  return {
    ok: true,
    prompt,
    initiator,
    respondent,
    constitution_loaded: Boolean(constitution),
    rules,
    entries,
  };
};

module.exports = {
  simulateDeliberationCycle,
  getConstitutionRules,
  resolveCycleAgents,
};
