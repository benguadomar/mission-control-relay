'use strict';
// Mission Control relay. Players create or join rooms of up to 4 by a
// 4-letter code; every JSON message a player sends goes to the rest of their
// room, stamped with the sender's id. The relay announces joins and leaves and
// hands the host role to the next player when the host leaves. It holds no game
// logic: the host's game is the official state.

const http = require('http');
const { WebSocketServer } = require('ws');

const MAX_PLAYERS = 4;
const CODE_LENGTH = 4;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
const MAX_NAME_LENGTH = 20;
const MAX_MESSAGE_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30000;
const SERVER_TYPES = new Set(['welcome', 'player_joined', 'player_left', 'error']);

function startServer(port, { log = console.log } = {}) {
  const rooms = new Map();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Mission Control relay is running.\n');
  });
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

  function send(socket, message) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(socket, code, message) {
    send(socket, { type: 'error', code, message });
  }

  function playerList(room) {
    return [...room.players.values()].map((player) => ({ id: player.id, name: player.name }));
  }

  function broadcast(room, message, exceptId) {
    for (const player of room.players.values()) {
      if (player.id !== exceptId) {
        send(player.socket, message);
      }
    }
  }

  function newCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
      }
    } while (rooms.has(code));
    return code;
  }

  function addPlayer(room, socket, name) {
    const id = room.nextId++;
    const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
    const player = { id, name: cleanName || `Player ${id}`, socket };
    room.players.set(id, player);
    socket.room = room;
    socket.playerId = id;
    return player;
  }

  function welcome(room, player) {
    send(player.socket, {
      type: 'welcome', room: room.code, you: player.id, host: room.hostId, players: playerList(room),
    });
  }

  function createRoom(socket, message) {
    const room = { code: newCode(), players: new Map(), nextId: 1, hostId: 0 };
    rooms.set(room.code, room);
    const player = addPlayer(room, socket, message.name);
    room.hostId = player.id;
    welcome(room, player);
    log(`room ${room.code} created by ${player.name}`);
  }

  function joinRoom(socket, message) {
    const code = typeof message.room === 'string' ? message.room.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      sendError(socket, 'room_not_found', `There is no room with the code "${code}".`);
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      sendError(socket, 'room_full', `Room ${code} already has ${MAX_PLAYERS} players.`);
      return;
    }
    const player = addPlayer(room, socket, message.name);
    welcome(room, player);
    broadcast(room, {
      type: 'player_joined', id: player.id, name: player.name, host: room.hostId, players: playerList(room),
    }, player.id);
    log(`${player.name} joined room ${code} (${room.players.size}/${MAX_PLAYERS})`);
  }

  function leaveRoom(socket) {
    const room = socket.room;
    if (!room) {
      return;
    }
    socket.room = null;
    const leaver = room.players.get(socket.playerId);
    room.players.delete(socket.playerId);
    if (room.players.size === 0) {
      rooms.delete(room.code);
      log(`room ${room.code} closed`);
      return;
    }
    if (room.hostId === socket.playerId) {
      // Map keeps join order, so the longest-waiting player becomes host.
      room.hostId = room.players.keys().next().value;
    }
    broadcast(room, { type: 'player_left', id: socket.playerId, host: room.hostId, players: playerList(room) });
    log(`${leaver ? leaver.name : 'a player'} left room ${room.code}; host is now player ${room.hostId}`);
  }

  function handle(socket, message) {
    if (message.type === 'create' || message.type === 'join') {
      if (socket.room) {
        sendError(socket, 'already_in_room', 'You are already in a room.');
      } else if (message.type === 'create') {
        createRoom(socket, message);
      } else {
        joinRoom(socket, message);
      }
    } else if (!socket.room) {
      sendError(socket, 'not_in_room', 'Create or join a room first.');
    } else if (SERVER_TYPES.has(message.type)) {
      sendError(socket, 'reserved_type', `Only the relay sends "${message.type}" messages.`);
    } else {
      broadcast(socket.room, { ...message, from: socket.playerId }, socket.playerId);
    }
  }

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendError(socket, 'bad_message', 'Messages must be JSON.');
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        sendError(socket, 'bad_message', 'Messages must be JSON objects with a "type".');
        return;
      }
      handle(socket, message);
    });
    socket.on('close', () => leaveRoom(socket));
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) {
      socket.terminate();
    }
    return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
  }

  return new Promise((resolve) => {
    // 0.0.0.0 is what Altare and similar panels expect. localhost still connects.
    server.listen(port, '0.0.0.0', () => resolve({ port: server.address().port, rooms, close }));
  });
}

// Altare gives the allocated port as SERVER_PORT. APP_PORT is the same idea on
// its app hosting. PORT is what Render sets. Local runs fall back to 8080.
function listenPort() {
  return Number(process.env.SERVER_PORT || process.env.APP_PORT || process.env.PORT) || 8080;
}

// Altare only hands out a raw IP and port. GitHub Pages is https, so the browser
// refuses ws://. ngrok turns the port into a public https address when
// NGROK_AUTHTOKEN is set, the same way Pump Royale did. NGROK_DOMAIN keeps that
// address from changing.
async function startPublicTunnel(port) {
  const authtoken = process.env.NGROK_AUTHTOKEN;
  if (!authtoken) return null;
  try {
    const ngrok = await import('@ngrok/ngrok');
    const listener = await ngrok.forward({
      addr: port,
      authtoken,
      domain: process.env.NGROK_DOMAIN || undefined,
    });
    const httpsUrl = listener.url();
    console.log(`Public address: ${httpsUrl}`);
    console.log(`Game URL: ${httpsUrl.replace(/^https:/, 'wss:')}`);
    return listener;
  } catch (error) {
    console.error(`ngrok tunnel failed: ${error.message}`);
    return null;
  }
}

if (require.main === module) {
  startServer(listenPort()).then((relay) => {
    console.log(`Mission Control relay listening on port ${relay.port}`);
    return startPublicTunnel(relay.port);
  });
}

module.exports = { startServer, MAX_PLAYERS };
