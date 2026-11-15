# Mission Control relay

A small WebSocket relay for online team play (up to 4 players per room). It
only passes messages around: the host's copy of the game is the official state,
and the relay holds no game logic.

## Run it on your computer

```bash
cd server
npm install
npm start          # listens on port SERVER_PORT, APP_PORT, PORT, or 8080
npm test           # optional self-test of the room rules
```

The game connects to the URL in `scripts/net/net_config.gd`, which is
`ws://localhost:8080` for local testing.

## What it does

- `{"type": "create", "name": "Ana"}` makes a room with a random 4-letter code
  and replies `{"type": "welcome", "room": "QXBT", "you": 1, "host": 1, "players": [...]}`.
- `{"type": "join", "room": "QXBT", "name": "Ben"}` joins it (at most 4 players).
  The joiner gets `welcome`; everyone else gets `player_joined`.
- Any other JSON object (it needs a `"type"`) is sent to everyone else in the
  room with `"from"` set to the sender's player id, so the host can trust who
  sent a request.
- When a player disconnects, the room gets `player_left` with the new `host`
  (the next player to have joined takes over if the host left). Empty rooms are
  deleted.
- Problems come back as `{"type": "error", "code": "room_full" | "room_not_found" | ..., "message": "..."}`.
- `GET /` answers with a short text, which Render uses as a health check.

## Deploy to Altare (same setup as Pump Royale)

Altare gives the server a raw IP and port. A game hosted on GitHub Pages is
`https`, and browsers block `ws://` from an `https` page. ngrok turns the
Altare port into a public `https` address so the game can use `wss://`.

1. In Altare, create a **Node.js** server. Upload this `server` folder, or
   connect the GitHub repo and set the root to `server`.
2. Start command: `npm start`. Altare sets `SERVER_PORT` itself.
3. In the server's environment variables, add:
   - `NGROK_AUTHTOKEN`: the token from your ngrok account
   - `NGROK_DOMAIN`: your static ngrok domain, so the address stays the same
4. Start the server and copy the `Game URL` line from the console. It looks
   like `wss://your-name.ngrok-free.app`.
5. Put that address in `scripts/net/net_config.gd`, export the web build again,
   and publish `build/web` with GitHub Pages.

Without those two ngrok variables the relay still runs, but only on the raw
Altare port, which GitHub Pages cannot use.

## Deploy to Render (free Web Service)

1. Push this project to a GitHub (or GitLab) repository.
2. On [render.com](https://render.com), click **New > Web Service** and connect
   the repository.
3. Fill in:
   - **Root Directory:** `server`
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Create Web Service**. Render sets the `PORT` environment variable
   itself, so there is nothing else to configure.
5. When the deploy finishes, copy the service URL, e.g.
   `https://mission-control-relay.onrender.com`, and put the secure WebSocket
   form of it in `scripts/net/net_config.gd`:

   ```gdscript
   const SERVER_URL := "wss://mission-control-relay.onrender.com"
   ```

   Then export the game again. A web build served over `https` can only use
   `wss://` addresses.

Free Render services go to sleep after about 15 minutes without traffic. The
first player to connect after that may wait up to a minute while it wakes up;
opening the service URL in a browser wakes it too.
