'use strict';
// Self-test for the relay: starts it on a free port and plays the room rules
// through real WebSocket clients. Run with `npm test`.

const assert = require('assert');
const WebSocket = require('ws');
const { startServer, MAX_PLAYERS } = require('./server');

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const index = waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) {
        waiters.splice(index, 1)[0].resolve(message);
      } else {
        inbox.push(message);
      }
    });
    socket.on('open', () => resolve({
      send: (message) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
      next(type) {
        const index = inbox.findIndex((message) => message.type === type);
        if (index >= 0) {
          return Promise.resolve(inbox.splice(index, 1)[0]);
        }
        return new Promise((done, fail) => {
          const timer = setTimeout(() => fail(new Error(`timed out waiting for "${type}"`)), 2000);
          waiters.push({ type, resolve: (message) => { clearTimeout(timer); done(message); } });
        });
      },
      inbox,
    }));
    socket.on('error', reject);
  });
}

async function check(name, body) {
  try {
    await body();
    console.log(`PASS  ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    return false;
  }
}

async function main() {
  const relay = await startServer(0, { log: () => {} });
  const url = `ws://localhost:${relay.port}`;
  const results = [];
  let ana;
  let ben;
  let room;

  results.push(await check('Create gives a 4-letter code and makes the creator host', async () => {
    ana = await connect(url);
    ana.send({ type: 'create', name: 'Ana' });
    const welcome = await ana.next('welcome');
    assert.match(welcome.room, /^[A-Z]{4}$/);
    assert.strictEqual(welcome.you, 1);
    assert.strictEqual(welcome.host, 1);
    room = welcome.room;
  }));

  results.push(await check('Join by code (any case) tells the room who joined', async () => {
    ben = await connect(url);
    ben.send({ type: 'join', room: room.toLowerCase(), name: 'Ben' });
    const welcome = await ben.next('welcome');
    assert.strictEqual(welcome.you, 2);
    assert.deepStrictEqual(welcome.players.map((player) => player.name), ['Ana', 'Ben']);
    const joined = await ana.next('player_joined');
    assert.strictEqual(joined.id, 2);
    assert.strictEqual(joined.host, 1);
  }));

  results.push(await check('Messages go to everyone else, stamped with the real sender', async () => {
    ben.send({ type: 'request', role: 'science_lead', action: 'instruments', value: 'radar', from: 1 });
    const relayed = await ana.next('request');
    assert.strictEqual(relayed.from, 2);
    assert.strictEqual(relayed.value, 'radar');
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(!ben.inbox.some((message) => message.type === 'request'), 'the sender got its own message back');
  }));

  results.push(await check('Players cannot fake relay announcements', async () => {
    ben.send({ type: 'player_left', id: 1 });
    const error = await ben.next('error');
    assert.strictEqual(error.code, 'reserved_type');
  }));

  results.push(await check(`A room holds at most ${MAX_PLAYERS} players`, async () => {
    const extra = [];
    for (let i = 3; i <= MAX_PLAYERS; i++) {
      const player = await connect(url);
      player.send({ type: 'join', room, name: `P${i}` });
      await player.next('welcome');
      extra.push(player);
    }
    const late = await connect(url);
    late.send({ type: 'join', room, name: 'Late' });
    assert.strictEqual((await late.next('error')).code, 'room_full');
    late.close();
    for (const player of extra) {
      player.close();
    }
  }));

  results.push(await check('Unknown codes are refused', async () => {
    const lost = await connect(url);
    lost.send({ type: 'join', room: 'ZZZZ' === room ? 'YYYY' : 'ZZZZ' });
    assert.strictEqual((await lost.next('error')).code, 'room_not_found');
    lost.close();
  }));

  results.push(await check('When the host leaves, the next player becomes host', async () => {
    ana.close();
    let left = await ben.next('player_left');
    while (left.id !== 1) {
      left = await ben.next('player_left');
    }
    assert.strictEqual(left.host, 2);
    assert.ok(left.players.every((player) => player.id !== 1));
  }));

  results.push(await check('An empty room is closed', async () => {
    ben.close();
    await new Promise((done) => setTimeout(done, 200));
    assert.ok(!relay.rooms.has(room));
  }));

  await relay.close();
  const failed = results.filter((passed) => !passed).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
