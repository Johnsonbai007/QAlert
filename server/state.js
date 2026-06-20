const DEFAULT_STATE = {
  currentToken: null,
  history: [],
  updatedAt: null,
  lastAction: 'System ready',
};

function normalizeToken(tokenNumber) {
  const token = Number(tokenNumber);
  if (!Number.isInteger(token) || token <= 0) return null;
  return token;
}

export function createQueueState() {
  return {
    ...structuredClone(DEFAULT_STATE),
    activePatientsBySocket: new Map(),
  };
}

export function registerPatient(state, socketId, tokenNumber) {
  const token = normalizeToken(tokenNumber);
  if (token === null) return;
  state.activePatientsBySocket.set(socketId, token);
}

export function unregisterPatient(state, socketId) {
  state.activePatientsBySocket.delete(socketId);
}

export function setCurrentToken(state, tokenNumber, action = 'Token updated') {
  const token = normalizeToken(tokenNumber);
  if (token === null) return state.currentToken;
  state.currentToken = token;
  state.history.push(token);
  state.updatedAt = new Date().toISOString();
  state.lastAction = action;
  return state.currentToken;
}

export function nextToken(state) {
  const next = Number.isFinite(state.currentToken) ? state.currentToken + 1 : 1;
  return setCurrentToken(state, next, 'Moved to next token');
}

export function skipToken(state) {
  const skipped = Number.isFinite(state.currentToken) ? state.currentToken + 1 : 1;
  return setCurrentToken(state, skipped, 'Skipped to next token');
}

export function recallPreviousToken(state) {
  if (state.history.length < 2) return state.currentToken;
  state.history.pop();
  const previous = state.history[state.history.length - 1];
  state.currentToken = previous;
  state.updatedAt = new Date().toISOString();
  state.lastAction = 'Recalled previous token';
  return previous;
}

export function resetQueue(state) {
  state.currentToken = null;
  state.history = [];
  state.activePatientsBySocket.clear();
  state.updatedAt = new Date().toISOString();
  state.lastAction = 'New day reset';
}

export function getPublicState(state) {
  const patients = [...new Set(state.activePatientsBySocket.values())]
    .filter((token) => Number.isFinite(token))
    .sort((a, b) => a - b)
    .map((token) => {
      const current = state.currentToken;
      const diff = Number.isFinite(current) ? token - current : null;
      let status = 'waiting';

      if (!Number.isFinite(current)) {
        status = 'waiting for first token';
      } else if (diff === 0) {
        status = 'being served';
      } else if (diff > 0 && diff <= 3) {
        status = 'near turn';
      } else if (diff > 0) {
        status = 'waiting';
      } else {
        status = 'already called';
      }

      return {
        token,
        tokensAhead: diff === null ? null : Math.max(diff, 0),
        status,
      };
    });

  return {
    currentToken: state.currentToken,
    previousToken: state.history.length > 1 ? state.history[state.history.length - 2] : null,
    history: [...state.history],
    activePatients: patients,
    activeCount: patients.length,
    updatedAt: state.updatedAt,
    lastAction: state.lastAction,
  };
}
