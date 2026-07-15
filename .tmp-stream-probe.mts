import { readFileSync } from 'node:fs';
import { WebSocket } from './packages/server/node_modules/ws/wrapper.mjs';

const origin = 'http://127.0.0.1:58629';
const sessionId = process.argv[2];
if (!sessionId) throw new Error('session id is required');
const token = readFileSync(`${process.env['USERPROFILE']}\\.nori-code\\server.token`, 'utf8').trim();

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${origin}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const socket = new WebSocket(origin.replace('http', 'ws') + '/api/v1/ws', [
  `nori-code.bearer.${token}`,
]);

const frames: unknown[] = [];
socket.on('message', async data => {
  const frame = JSON.parse(data.toString()) as {
    type: string;
    id?: string;
    payload?: Record<string, unknown>;
  };
  frames.push(frame);
  console.log('frame', frame.type, frame.id ?? '', JSON.stringify(frame.payload));
  if (frame.type === 'server_hello') {
    socket.send(JSON.stringify({
      type: 'client_hello',
      id: 'probe-hello',
      payload: { client_id: 'nori-stream-probe', subscriptions: [sessionId] },
    }));
    return;
  }
  if (frame.type === 'ping') {
    socket.send(JSON.stringify({ type: 'pong', payload: { nonce: frame.payload?.['nonce'] } }));
    return;
  }
  if (frame.type === 'ack' && frame.id === 'probe-hello') {
    console.log('profile', JSON.stringify(await request(`/sessions/${encodeURIComponent(sessionId)}/profile`, {
      method: 'POST',
      body: JSON.stringify({ agent_config: { model: 'deepseek/deepseek-v4-flash', thinking: 'off' } }),
    })));
    console.log('prompt', JSON.stringify(await request(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: 'POST',
      body: JSON.stringify({
        content: [{ type: 'text', text: '用中文连续写十二句话，每句话说明一个桌面应用可用性原则，不要调用工具。' }],
      }),
    })));
    return;
  }
  if (frame.type === 'assistant.delta' || frame.type === 'thinking.delta') {
    const delta = frame.payload?.['delta'];
    console.log(frame.type, typeof delta === 'string' ? delta.length : typeof delta, JSON.stringify(delta));
  } else if (frame.type === 'turn.started' || frame.type === 'turn.ended' || frame.type === 'prompt.completed' || frame.type === 'error') {
    console.log(frame.type, JSON.stringify(frame.payload));
  }
  if (frame.type === 'prompt.completed') {
    setTimeout(() => socket.close(), 100);
  }
});

await new Promise<void>((resolve, reject) => {
  socket.once('close', () => resolve());
  socket.once('error', reject);
  setTimeout(() => reject(new Error(`probe timeout; frames=${frames.length}`)), 60_000);
});
