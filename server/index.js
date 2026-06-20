import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import {
  createQueueState,
  getPublicState,
  nextToken,
  recallPreviousToken,
  registerPatient,
  resetQueue,
  skipToken,
  setCurrentToken,
  unregisterPatient,
} from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: isProduction ? false : '*',
    methods: ['GET', 'POST'],
  },
});

const queueState = createQueueState();

function broadcastState() {
  io.emit('queue:state', getPublicState(queueState));
}

app.get('/api/state', (_req, res) => {
  res.json(getPublicState(queueState));
});

io.on('connection', (socket) => {
  socket.emit('queue:state', getPublicState(queueState));

  socket.on('patient:register', (payload = {}) => {
    const tokenNumber = Number(payload.tokenNumber);
    if (!Number.isFinite(tokenNumber)) return;
    registerPatient(queueState, socket.id, tokenNumber);
    socket.data.tokenNumber = tokenNumber;
    socket.emit('queue:state', getPublicState(queueState));
    broadcastState();
  });

  socket.on('queue:set', (payload = {}) => {
    const tokenNumber = Number(payload.tokenNumber);
    if (!Number.isFinite(tokenNumber)) return;
    setCurrentToken(queueState, tokenNumber, 'Token updated manually');
    broadcastState();
  });

  socket.on('queue:next', () => {
    nextToken(queueState);
    broadcastState();
  });

  socket.on('queue:skip', () => {
    skipToken(queueState);
    broadcastState();
  });

  socket.on('queue:recall', () => {
    recallPreviousToken(queueState);
    broadcastState();
  });

  socket.on('queue:reset', () => {
    resetQueue(queueState);
    broadcastState();
  });

  socket.on('disconnect', () => {
    unregisterPatient(queueState, socket.id);
    broadcastState();
  });
});

if (!isProduction) {
  const vite = await createViteServer({
    root,
    appType: 'custom',
    server: {
      middlewareMode: true,
    },
  });

  app.use(vite.middlewares);
  app.use('*', async (req, res) => {
    try {
      const url = req.originalUrl;
      let template = fs.readFileSync(path.resolve(root, 'index.html'), 'utf-8');
      template = await vite.transformIndexHtml(url, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      res.status(500).end(error.stack);
    }
  });
} else {
  const distPath = path.resolve(root, 'dist');
  app.use(express.static(distPath));
  app.use('*', (_req, res) => {
    res.sendFile(path.resolve(distPath, 'index.html'));
  });
}

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`QAlert listening on http://localhost:${port}`);
});
