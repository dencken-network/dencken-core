const fs = require('fs');
const path = require('path');

const AGENTS_CONFIG_PATH = path.join(__dirname, '../../config/agents.json');
const DEFAULT_AGENTS = [
  {
    id: 'agent-alpha',
    label: 'Alpha',
    provider: 'openrouter',
    model: 'mistralai/mistral-7b-instruct',
    role: 'initiator',
    active: true,
  },
  {
    id: 'agent-beta',
    label: 'Beta',
    provider: 'groq',
    model: 'llama3-8b-8192',
    role: 'respondent',
    active: true,
  },
];

const normalizeAgent = (agent = {}) => {
  if (!agent || typeof agent !== 'object') return null;
  return {
    id: agent.id || agent.name || 'agent-unnamed',
    label: agent.label || agent.name || agent.id || 'Unnamed Agent',
    provider: agent.provider || 'openrouter',
    model: agent.model || 'default-model',
    role: agent.role || 'observer',
    active: agent.active !== false,
    ...agent,
  };
};

const getConstitutionAgentDefinitions = (constitution) => {
  if (!constitution || typeof constitution !== 'object') return [];

  const candidates = [
    constitution.agents,
    constitution.agent_pool,
    constitution.policy && constitution.policy.agents,
    constitution.rules && constitution.rules.agents,
    constitution.rules && constitution.rules.agent_pool,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(normalizeAgent).filter(Boolean);
    }
  }

  return [];
};

const loadAgentPool = (constitution = null) => {
  const constitutionAgents = getConstitutionAgentDefinitions(constitution);

  try {
    if (!fs.existsSync(AGENTS_CONFIG_PATH)) {
      return constitutionAgents.length > 0 ? constitutionAgents : DEFAULT_AGENTS;
    }

    const raw = fs.readFileSync(AGENTS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed.agents)) {
      return constitutionAgents.length > 0 ? constitutionAgents : DEFAULT_AGENTS;
    }

    const activeAgents = parsed.agents
      .map(normalizeAgent)
      .filter((agent) => agent && agent.active === true);

    return activeAgents.length > 0 ? activeAgents : constitutionAgents.length > 0 ? constitutionAgents : DEFAULT_AGENTS;
  } catch (error) {
    console.error('Failed to load agents pool:', error.message);
    return constitutionAgents.length > 0 ? constitutionAgents : DEFAULT_AGENTS;
  }
};

module.exports = {
  loadAgentPool,
  DEFAULT_AGENTS,
  normalizeAgent,
};
