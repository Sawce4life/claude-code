export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = status === 0;
  }
}

let authToken = null;
export function setToken(token) { authToken = token || null; }
export function getToken() { return authToken; }

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('No connection right now.', 0);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status);
  }
  return payload;
}

export const api = {
  health: () => request('GET', '/api/health'),
  register: (body) => request('POST', '/api/auth/register', body),
  login: (body) => request('POST', '/api/auth/login', body),
  me: () => request('GET', '/api/me'),
  updateMe: (body) => request('PATCH', '/api/me', body),
  changePassword: (body) => request('POST', '/api/auth/password', body),
  pull: (since) => request('GET', `/api/sync?since=${encodeURIComponent(since)}`),
  push: (since, changes) => request('POST', '/api/sync', { since, changes }),
  today: () => request('GET', '/api/today'),
  parse: (text) => request('POST', '/api/ai/parse', { text }),
  brief: () => request('POST', '/api/ai/brief', {}),
  suggest: (leadId) => request('POST', '/api/ai/suggest', { leadId }),
};

/**
 * Streams an answer token by token. EventSource cannot POST, so this reads the
 * server-sent-event framing off the fetch body itself.
 */
export async function askStream({ question, history = [], onDelta, signal }) {
  let response;
  try {
    response = await fetch('/api/ai/ask', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ question, history }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('No connection right now.', 0);
  }

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed (${response.status})`;
    try { message = JSON.parse(text).error || message; } catch { /* keep default */ }
    throw new ApiError(message, response.status);
  }
  if (!response.body) throw new ApiError('This browser cannot stream the reply.', 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let failure = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (block.startsWith(':')) continue;

      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (!dataLines.length) continue;

      let data;
      try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }

      if (event === 'delta') {
        answer += data;
        if (onDelta) onDelta(data);
      } else if (event === 'done') {
        answer = data.answer ?? answer;
      } else if (event === 'failed') {
        failure = data.message || 'The assistant could not answer.';
      }
    }
  }

  if (failure) throw new ApiError(failure, 502);
  return answer;
}
