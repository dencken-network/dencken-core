const crypto = require('crypto');
const { loadAgentPool } = require('./pool');
const ledger = require('../core/ledger');
const { loadConfigConstitution } = require('../core/constitutionStore');

const defaultPrompt = 'Propose a new action for the network.';

const hashManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') return null;
  try {
    return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  } catch (err) {
    return null;
  }
};

const buildManifestReference = (manifest) => {
  if (!manifest || typeof manifest !== 'object') return null;

  const version = manifest.version || manifest.meta?.version || manifest.brief_version || 'unknown';
  const id = manifest.id || manifest.name || 'manifest';
  const hash = hashManifest(manifest);

  return {
    id,
    version,
    hash,
    source: 'loaded-constitution',
  };
};

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

const getMaxMessageLimit = (constitution) => {
  const rules = getConstitutionRules(constitution);
  const candidates = [
    rules.max_messages,
    rules.maxMessages,
    rules.max_conversation_messages,
    rules.maxConversationMessages,
    rules.cycle && rules.cycle.max_messages,
    rules.cycle && rules.cycle.maxMessages,
  ];

  const match = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  return match !== undefined ? Number(match) : null;
};

const buildPromptGuard = (constitution) => {
  const maxMessages = getMaxMessageLimit(constitution);
  if (!maxMessages) return '';

  return ` Conversation rule: keep this cycle to ${maxMessages} messages maximum. In the last two messages, either conclude with a final decision or propose a new cycle for continued deliberation.`;
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

const makeContent = (stage, prompt, initiator, respondent, manifestRef = null) => {
  const manifestSuffix = manifestRef
    ? ` [manifest:${manifestRef.id}@${manifestRef.version}:${manifestRef.hash || 'unknown'}]`
    : '';

  switch (stage) {
    case 'initiator_proposal':
      return `${initiator.label} (${initiator.id}) proposes: ${prompt}${manifestSuffix}`;
    case 'respondent_response':
      return `${respondent.label} (${respondent.id}) responds to ${initiator.label}: I reviewed the proposal and suggest a refinement that improves resilience and clarity.${manifestSuffix}`;
    case 'synthesis':
      return `Synthesis by the board: we accept the proposal with the following summary and next step. ${respondent.label}'s refinement has been incorporated.${manifestSuffix}`;
    default:
      return `${stage}: ${prompt}${manifestSuffix}`;
  }
};

const simulateDeliberationCycle = async (opts = {}) => {
  const basePrompt = opts.prompt || defaultPrompt;
  const useManifest = Boolean(opts.use_manifest === true || opts.manifest);
  const manifest = typeof opts.manifest === 'object' && opts.manifest
    ? opts.manifest
    : (useManifest ? (await loadConfigConstitution().catch(() => null)) : null);

  const constitution = opts.constitution || manifest;
  const agents = loadAgentPool(constitution);
  const { initiator, respondent, rules } = resolveCycleAgents(agents, constitution);

  if (!initiator || !respondent) {
    throw new Error('Unable to select cycle agents from pool.');
  }

  const manifestRef = buildManifestReference(manifest);
  const maxMessageLimit = getMaxMessageLimit(constitution);
  const prompt = `${basePrompt}${buildPromptGuard(constitution)}`;
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
    const content_plain = makeContent(stage.record_type, prompt, initiator, respondent, manifestRef);
    const entry = await ledger.appendRecord({
      record_type: stage.record_type,
      content_plain,
      manifest: manifestRef,
    });
    entries.push(entry);
  }

  return {
    ok: true,
    prompt,
    initiator,
    respondent,
    constitution_loaded: Boolean(constitution),
    manifest_used: Boolean(manifestRef),
    manifest: manifestRef,
    max_message_limit: maxMessageLimit,
    rules,
    entries,
  };
};

module.exports = {
  simulateDeliberationCycle,
  getConstitutionRules,
  resolveCycleAgents,
  buildManifestReference,
  hashManifest,
  getMaxMessageLimit,
};
