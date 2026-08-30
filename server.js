require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Determines the base URL a player would need to reach this server, by reading exactly
// what the host's own browser used to connect (from the request itself) — rather than
// guessing via a platform-specific environment variable or the server's own network
// interfaces. This works correctly whether running on a local network (e.g.
// http://192.168.1.42:3000), deployed to Render or any other host (e.g.
// https://queue-it-up.onrender.com), or behind a custom domain — with no per-platform
// special-casing required.
function getJoinBaseUrl(socket) {
  const host = socket.handshake.headers.host;
  if (!host) return null;
  const proto = socket.handshake.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

app.use(express.static(path.join(__dirname, 'public')));

// ---------- iTunes Search API proxy (default search + 30s preview clip) ----------
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing query param q' });
  }
  try {
    const itunesRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=15`
    );
    if (!itunesRes.ok) throw new Error(`iTunes responded ${itunesRes.status}`);
    const data = await itunesRes.json();
    const results = (data.results || [])
      .filter(track => track.previewUrl)
      .map(track => ({
        id: track.trackId,
        title: track.trackName,
        artist: track.artistName || 'Unknown artist',
        album: track.collectionName || '',
        cover: track.artworkUrl100 ? track.artworkUrl100.replace('100x100', '300x300') : '',
        previewUrl: track.previewUrl,
        durationSec: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : null
      }));
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(502).json({ error: 'Search failed, try again' });
  }
});

// ---------- YouTube search proxy (optional: lets a player pick a custom start time) ----------
app.get('/api/youtube-search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing query param q' });
  }
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube search is not set up yet (missing YOUTUBE_API_KEY in .env).' });
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=10&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
    const ytRes = await fetch(url);
    const data = await ytRes.json();
    if (!ytRes.ok) {
      console.error('YouTube search error:', data);
      return res.status(502).json({ error: data.error?.message || 'YouTube search failed' });
    }
    const results = (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      // Prefer the highest-resolution thumbnail YouTube provides for this video
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || ''
    }));
    res.json({ results });
  } catch (err) {
    console.error('YouTube search error:', err);
    res.status(502).json({ error: 'YouTube search failed, try again' });
  }
});

// ---------- Game state ----------
const PROMPTS = [
  "Play the song you'd play to make your enemies dance",
  "Play a song that sounds like a rainy Sunday morning",
  "Play the ultimate 'we're about to get kicked out' song",
  "Play a song your parents would be shocked you like",
  "Play a song that best describes your last group chat drama",
  "Play a song for the villain's entrance in a movie",
  "Play that song that makes your mom say, \"Oh, this is my jam!\" and immediately start doing an embarrassing dance",
  "Play the ultimate track for a classic teen movie makeover montage where a character takes off their glasses and suddenly becomes popular",
  "Play the song that plays during a rainy, dramatic airport chase scene where someone runs to confess their love before the plane takes off",
  "Play the ultimate walkout song that would blast over the stadium speakers if you were a professional baseball or softball player stepping up to bat",
  "Play the most hilariously awkward, cheesy, or overly intense song you could possibly put on a playlist for lovemaking",
  "Play the ultimate 70s disco or funk track that forces absolutely everyone to hit the dance floor",
  "Play the most legendary, instantly recognizable 80s synth or bass intro",
  "Play the absolute cringiest song from your middle school phase",
  "Play the theme song for when you accidentally send a screenshot to the exact person you screenshotted",
  "Play the song that plays in the background while you are placed on hold by customer service for 3 hours",
  "Play a song to completely ruin the mood at a romantic candlelit dinner",
  "Play the track that plays during a slow-motion explosion while the hero walks away without looking back",
  "Play the background music for a montage of someone frantically cleaning their apartment 10 minutes before guests arrive",
  "Play the ending credits theme song for a terrible low-budget horror movie",
  "Play the upbeat shopping spree song that plays while characters walk out of a store carrying dozens of bags",
  "Play the acoustic ballad or pop-rock track that hits right when the main couple breaks up in a rom-com",
  "Play the upbeat, cheesy love song that plays during the happy ending credits of a 2000s romantic comedy",
  "Play a song from a movie soundtrack that is so iconic, you instantly picture the exact movie scene the second the audio starts",
  "Play a track you secretly know every single word to, even though you publicly claim to hate the genre",
  "Play a nostalgic 2000s track that instantly takes everyone back to the days of phones and MP3 players",
  "Play the ultimate \"main character energy\" walking music",
  "Play a song that instantly makes you want to speed on the highway",
  "Play the track that guarantees nobody hands you the AUX cord ever again",
  "Play the ultimate 80s club banger, dance-pop, or synth track that definitely got your mom onto the dance floor during her prime party years",
  "Play a song you would absolutely blast alone in your car, but instantly turn down if you stop at a red light next to people",
  "Play an iconic 90s anthem that defined a whole generation",
  "Play the opening track of a movie that immediately lets the audience know they are watching an absolute masterpiece",
  "Play the song that feels like the ultimate, high-energy victory lap track at the very end of a sports movie",
  "Play the song you would choose to perform if you were forced to do a celebrity lip-sync battle to save your life",
  "Play a song that feels like a warm, comforting hug on a rainy Sunday afternoon",
  "Play the track you want playing in the background if you ever get into a dramatic, slow-motion food fight",
  "Play the song that you think should officially replace the national anthem",
  "Play a holiday song that is acceptable to blast at full volume even if it is the middle of July",
  "Play a holiday song that you would be happy to never hear again",
  "Play the ultimate, most unvarnished, cringe-inducing, cheesy love song ever written",
  "Play a romantic ballad so incredibly over-the-top dramatic that it makes you laugh out loud",
  "Play a song that instantly reminds you of a loved one or a specific person you care about deeply",
  "Play a beautiful, sweet track that feels like the perfect song for a first dance at a wedding",
  "Play a song that makes you feel incredibly nostalgic, safe, and happy whenever you hear it",
  "Play the track you would play to comfort a friend who is going through a really tough time",
  "Play a track that is surprisingly romantic",
  "Play a vintage track that your grandma would look at you and say, 'Oh, this is a real song, not like the noise you listen to today'",
  "Play the ultimate \"feel good\" track that brings together three different generations on the dance floor",
  "Play the absolute heaviest, highest-energy song that instantly makes you want to lift a car or break a personal record at the gym",
  "Play the song that blasts in the background during an intense, high-stakes movie brawl where the main character takes down an entire room of bad guys",
  "Play the ultimate, classic dad-rock anthem that forces every guy standing near a grill to instantly nod their head",
  "Play the track that a sports team blasts in the locker room right before running out onto the field for a championship game",
  "Play the high-tempo song that plays during a high-speed car chase involving muscle cars and explosions",
  "Play the track that guarantees every single guy in the room will instantly start chanting or shouting the chorus together",
  "Play a dark, heavy, or menacing track that makes you look like the ultimate final boss walking into a room",
  "Play a nostalgic early-2000s rock or hip-hop track that instantly brings back memories of college house parties and cheap beer",
  "Play a great go-to karaoke song",
  "Play a song that requires an immediate volume turn-up, no exceptions",
  "Play a song that makes bartenders want to unplug the jukebox immediately",
  "Play a song everyone knows the words to, even if they hate it",
  "Play a song that makes you immediately change the radio station",
  "Play the absolute worst song to play at a wedding",
  "Play a song from a famous artist or band you think is wildly overrated",
  "Play a song from a famous artist or band you think is wildly underrated",
  "Play a song that was ruined because it was wildly over played",
  "Play a song that everybody loves, but you secretly hate"
];

/** rooms: Map<code, {
 *   hostSocketId,                     // the TV device — the ONLY device that can start/restart the game
 *   phase: 'lobby'|'picking'|'reveal'|'game-over',
 *   prompt, promptIndex,
 *   players: Map<socketId, { name, pick, hasPicked, score }>,
 *      // pick = { id, title, artist, album, cover, previewUrl, durationSec, youtube?: { videoId, startSeconds } }
 *   gameStarted: bool,
 *   playerOrderSnapshot: [socketId, ...],   // locked in when the game (re)starts; judge cycles through this
 *   currentRoundNumber, totalRounds,        // totalRounds = players × turnsPerPlayer (1, 2, or 3)
 *   reveal: { picks: [{playerSocketId, playerName, track}], revealIndex, subPhase: 'sequential'|'choosing', nowPlayingIndex, winnerIndex, canAdvance, advanceTimer } | null
 * }>
 */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function pickPrompt(excludeIndex) {
  let idx;
  do {
    idx = Math.floor(Math.random() * PROMPTS.length);
  } while (PROMPTS.length > 1 && idx === excludeIndex);
  return idx;
}

function clampTurns(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 2;
  return Math.min(3, Math.max(1, Math.round(num)));
}

function getCurrentJudgeId(room) {
  if (!room.gameStarted || room.currentRoundNumber < 1 || !room.playerOrderSnapshot.length) return null;
  const idx = (room.currentRoundNumber - 1) % room.playerOrderSnapshot.length;
  return room.playerOrderSnapshot[idx] || null;
}

function playerListPayload(room) {
  const judgeId = getCurrentJudgeId(room);
  return Array.from(room.players.entries()).map(([id, p]) => ({
    name: p.name,
    hasPicked: p.hasPicked,
    score: p.score,
    isJudge: id === judgeId,
    connected: p.connected !== false
  }));
}

// Replays the sequence of setup events a reconnecting player needs to land back in the
// correct spot — reusing the SAME client-side handlers a fresh round already relies on,
// rather than building a separate "resume" code path on the client.
function sendCatchUpState(socket, room) {
  if (room.phase === 'game-over') {
    socket.emit('room:game-over', { scoreboard: buildScoreboard(room) });
    return;
  }
  if (!room.gameStarted) return; // still in the lobby — nothing to catch up on

  const judgeId = getCurrentJudgeId(room);
  const judgePlayer = room.players.get(judgeId);
  socket.emit('room:round-started', {
    roundNumber: room.currentRoundNumber,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    judgeName: judgePlayer?.name || 'Unknown'
  });
  socket.emit('room:your-role', { isJudge: socket.id === judgeId });

  if (room.phase === 'picking') {
    const me = room.players.get(socket.id);
    if (me && socket.id !== judgeId && me.hasPicked) {
      socket.emit('room:already-picked');
    }
  }

  if (room.phase === 'reveal' && room.reveal) {
    socket.emit('room:reveal', {
      picks: room.reveal.picks.map(({ playerName, track }) => ({ playerName, track })),
      revealIndex: room.reveal.revealIndex,
      subPhase: room.reveal.subPhase
    });
    if (room.reveal.subPhase === 'choosing') {
      socket.emit('room:reveal-choosing');
      if (room.reveal.winnerIndex !== null) {
        const winnerEntry = room.reveal.picks[room.reveal.winnerIndex];
        socket.emit('room:winner-chosen', {
          index: room.reveal.winnerIndex,
          playerName: winnerEntry.playerName,
          scoreboard: buildScoreboard(room)
        });
      }
    }
  }
}

function allNonJudgePicked(room) {
  const judgeId = getCurrentJudgeId(room);
  const nonJudge = Array.from(room.players.entries()).filter(([id]) => id !== judgeId);
  return nonJudge.length > 0 && nonJudge.every(([, p]) => p.hasPicked);
}

function buildScoreboard(room) {
  return Array.from(room.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function emitStartError(room, error) {
  io.to(room.hostSocketId).emit('room:start-game-error', { error });
}

function startRound(room, roomCode) {
  room.promptIndex = pickPrompt(room.promptIndex ?? undefined);
  room.prompt = PROMPTS[room.promptIndex];
  room.phase = 'picking';
  room.reveal = null;
  for (const p of room.players.values()) {
    p.pick = null;
    p.hasPicked = false;
  }

  const judgeId = getCurrentJudgeId(room);
  const judgePlayer = room.players.get(judgeId);

  io.to(roomCode).emit('room:round-started', {
    roundNumber: room.currentRoundNumber,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    judgeName: judgePlayer?.name || 'Unknown'
  });
  for (const id of room.players.keys()) {
    io.to(id).emit('room:your-role', { isJudge: id === judgeId });
  }
  io.to(roomCode).emit('room:players-updated', playerListPayload(room));
}

function advanceRoundOrEndGame(room, roomCode) {
  if (room.currentRoundNumber >= room.totalRounds) {
    room.phase = 'game-over';
    io.to(roomCode).emit('room:game-over', { scoreboard: buildScoreboard(room) });
  } else {
    room.currentRoundNumber += 1;
    io.to(roomCode).emit('room:next-round-sound');
    startRound(room, roomCode);
  }
}

io.on('connection', (socket) => {

  // ---- Host creates a room (TV device — the only device that can start/restart the game) ----
  socket.on('host:create-room', (_data, ack) => {
    const code = makeRoomCode();
    rooms.set(code, {
      hostSocketId: socket.id,
      phase: 'lobby',
      prompt: null,
      promptIndex: null,
      players: new Map(),
      gameStarted: false,
      playerOrderSnapshot: [],
      currentRoundNumber: 0,
      totalRounds: 0,
      reveal: null
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'host';
    ack?.({ ok: true, code, joinBaseUrl: getJoinBaseUrl(socket) });
  });

  // ---- Player joins a room ----
  socket.on('player:join', ({ code, name }, ack) => {
    const roomCode = (code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: 'Room not found. Check the code.' });

    const cleanName = (name || '').trim().slice(0, 20) || 'Player';

    // Reconnection: if this name matches a player who disconnected mid-game, reclaim their
    // existing slot (score, current pick, judge rotation position all preserved) instead of
    // treating this as a brand-new join. This works even after the game has started — that's
    // the whole point, since a fresh join is deliberately blocked once the game is underway.
    const reconnectEntry = Array.from(room.players.entries())
      .find(([, p]) => p.connected === false && p.name.toLowerCase() === cleanName.toLowerCase());

    if (reconnectEntry) {
      const [oldSocketId, playerData] = reconnectEntry;
      room.players.delete(oldSocketId);
      playerData.connected = true;
      room.players.set(socket.id, playerData);

      // Fix up anywhere the old (now-stale) socket id was recorded, so judge rotation and
      // winner-scoring both keep working correctly for this player going forward.
      if (room.playerOrderSnapshot.length) {
        room.playerOrderSnapshot = room.playerOrderSnapshot.map(id => id === oldSocketId ? socket.id : id);
      }
      if (room.reveal && room.reveal.picks) {
        room.reveal.picks.forEach(p => { if (p.playerSocketId === oldSocketId) p.playerSocketId = socket.id; });
      }

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = 'player';

      ack?.({ ok: true, reconnected: true });
      sendCatchUpState(socket, room);
      io.to(roomCode).emit('room:players-updated', playerListPayload(room));
      return;
    }

    // ---- Fresh join ----
    if (room.gameStarted) {
      return ack?.({ ok: false, error: 'This game already started. Ask the host to open a new room.' });
    }
    // Max 9 players so a round can never produce more than 8 submissions (1 judge + 8 others) —
    // matching the host screen's 2-column, 4-row grid capacity.
    if (room.players.size >= 9) {
      return ack?.({ ok: false, error: 'This room is full (9 players max).' });
    }
    const nameTaken = Array.from(room.players.values())
      .some(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (nameTaken) {
      return ack?.({ ok: false, error: 'That name is already taken in this room — pick another.' });
    }

    room.players.set(socket.id, { name: cleanName, pick: null, hasPicked: false, score: 0, connected: true });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.role = 'player';

    ack?.({ ok: true });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
    io.to(roomCode).emit('room:player-joined', { name: cleanName });
  });

  // ---- Host starts the game (this click is also what satisfies browser autoplay policy
  // for songs played later via remote commands from a player's phone) ----
  socket.on('start-game', ({ turnsPerPlayer } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.gameStarted) return;
    if (socket.id !== room.hostSocketId) return;

    if (room.players.size < 3) {
      emitStartError(room, 'Need at least 3 players to start (one judges each round, others pick).');
      return;
    }

    room.playerOrderSnapshot = Array.from(room.players.keys());
    room.totalRounds = room.playerOrderSnapshot.length * clampTurns(turnsPerPlayer);
    room.currentRoundNumber = 1;
    room.gameStarted = true;
    startRound(room, roomCode);
  });

  // ---- Host restarts with fresh scores after game-over ----
  socket.on('play-again', ({ turnsPerPlayer } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'game-over') return;
    if (socket.id !== room.hostSocketId) return;

    if (room.players.size < 3) {
      emitStartError(room, 'Need at least 3 players to start a new game.');
      return;
    }

    for (const p of room.players.values()) p.score = 0;
    room.playerOrderSnapshot = Array.from(room.players.keys());
    room.totalRounds = room.playerOrderSnapshot.length * clampTurns(turnsPerPlayer);
    room.currentRoundNumber = 1;
    room.gameStarted = true;
    io.to(roomCode).emit('room:play-again-sound');
    startRound(room, roomCode);
  });

  // ---- Non-judge player submits/updates their pick ----
  // track can optionally include a `youtube: { videoId, startSeconds }` field —
  // the server doesn't need to know or care, it just stores and forwards whatever was submitted.
  socket.on('player:submit-pick', (track) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;

    const judgeId = getCurrentJudgeId(room);
    if (socket.id === judgeId) return; // the judge doesn't submit a pick

    const player = room.players.get(socket.id);
    if (!player) return;

    player.pick = track;
    player.hasPicked = true;
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
    io.to(roomCode).emit('room:pick-submitted', { playerName: player.name });

    if (allNonJudgePicked(room) && judgeId) {
      io.to(roomCode).emit('room:all-picked');
    }
  });

  // ---- Judge requests a new random prompt mid-round ----
  // Since the prompt changed, any picks submitted for the old one no longer make sense —
  // they're cleared and everyone (except the judge) needs to submit again.
  socket.on('judge:new-prompt', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;
    if (socket.id !== getCurrentJudgeId(room)) return;

    room.promptIndex = pickPrompt(room.promptIndex);
    room.prompt = PROMPTS[room.promptIndex];
    for (const p of room.players.values()) {
      p.pick = null;
      p.hasPicked = false;
    }
    io.to(roomCode).emit('room:prompt-changed', { prompt: room.prompt });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });

  // ---- Judge starts the reveal ----
  socket.on('judge:start-reveal', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;
    const judgeId = getCurrentJudgeId(room);
    if (socket.id !== judgeId || !allNonJudgePicked(room)) return;

    const picks = Array.from(room.players.entries())
      .filter(([id, p]) => id !== judgeId && p.hasPicked && p.pick)
      .map(([id, p]) => ({ playerSocketId: id, playerName: p.name, track: p.pick }))
      .sort(() => Math.random() - 0.5);

    // subPhase 'sequential': picks are viewed one at a time, no winner button yet.
    // subPhase 'choosing': every pick has been viewed; the judge can now crown a winner.
    room.reveal = { picks, revealIndex: 0, subPhase: 'sequential', nowPlayingIndex: null, winnerIndex: null, canAdvance: false, advanceTimer: null };
    room.phase = 'reveal';
    io.to(roomCode).emit('room:reveal', {
      picks: picks.map(({ playerName, track }) => ({ playerName, track })),
      revealIndex: 0,
      subPhase: 'sequential'
    });
  });

  // ---- Judge plays a specific pick (audio/video actually plays on the TV device) ----
  // Plays until the clip ends naturally or the judge advances — no fixed time cap.
  // 3 seconds after playback starts, the judge is allowed to advance (Next unlocks client-side).
  socket.on('judge:play-pick', (index) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== getCurrentJudgeId(room)) return;
    // During the sequential walkthrough, only the current card can be played
    if (room.reveal.subPhase === 'sequential' && index !== room.reveal.revealIndex) return;
    const entry = room.reveal.picks[index];
    if (!entry) return;

    room.reveal.nowPlayingIndex = index;
    io.to(roomCode).emit('room:now-playing', { index, track: entry.track, playerName: entry.playerName });

    if (room.reveal.subPhase === 'sequential' && !room.reveal.canAdvance) {
      clearTimeout(room.reveal.advanceTimer);
      const revealAtStart = room.reveal; // guards against a stale timer firing after start-reveal/next-pick replaces this object
      room.reveal.advanceTimer = setTimeout(() => {
        if (room.reveal !== revealAtStart || room.reveal.revealIndex !== index) return;
        room.reveal.canAdvance = true;
        io.to(socket.id).emit('room:can-advance');
      }, 3000);
    }
  });

  // ---- Judge stops playback ----
  socket.on('judge:stop-playback', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.reveal) return;
    if (socket.id !== getCurrentJudgeId(room)) return;

    room.reveal.nowPlayingIndex = null;
    // If they stopped before the 3s mark, cancel the pending unlock — they'll need
    // to press play again. If it already unlocked, stopping doesn't re-lock it.
    if (!room.reveal.canAdvance) clearTimeout(room.reveal.advanceTimer);
    io.to(roomCode).emit('room:stop-playback');
  });

  // ---- Judge advances from the current pick to the next one in the walkthrough ----
  // Requires at least 3 seconds of playback (or the clip ending naturally) so it can't be skipped untouched.
  socket.on('judge:next-pick', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== getCurrentJudgeId(room)) return;
    if (room.reveal.subPhase !== 'sequential') return;
    if (!room.reveal.canAdvance) return;

    clearTimeout(room.reveal.advanceTimer);
    room.reveal.nowPlayingIndex = null;
    io.to(roomCode).emit('room:stop-playback');

    if (room.reveal.revealIndex + 1 < room.reveal.picks.length) {
      room.reveal.revealIndex += 1;
      room.reveal.canAdvance = false;
      io.to(roomCode).emit('room:reveal-advanced', { revealIndex: room.reveal.revealIndex });
    } else {
      room.reveal.subPhase = 'choosing';
      io.to(roomCode).emit('room:reveal-choosing');
    }
  });

  // ---- TV reports that a clip finished entirely on its own ----
  // Also unlocks Next immediately as a safety net, in case a clip happens to run under 3 seconds.
  socket.on('host:playback-ended', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostSocketId || !room.reveal) return;

    room.reveal.nowPlayingIndex = null;
    if (room.reveal.subPhase === 'sequential' && !room.reveal.canAdvance) {
      clearTimeout(room.reveal.advanceTimer);
      room.reveal.canAdvance = true;
      const judgeId = getCurrentJudgeId(room);
      if (judgeId) io.to(judgeId).emit('room:can-advance');
    }
    io.to(roomCode).emit('room:stop-playback');
  });



  // ---- Judge crowns a winner: +100 points to that player ----
  socket.on('judge:choose-winner', (index) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== getCurrentJudgeId(room)) return;
    if (room.reveal.subPhase !== 'choosing') return; // must view every pick first
    if (room.reveal.winnerIndex !== null) return; // already decided this round

    const entry = room.reveal.picks[index];
    if (!entry) return;

    room.reveal.winnerIndex = index;
    const winnerPlayer = room.players.get(entry.playerSocketId);
    if (winnerPlayer) winnerPlayer.score += 100;

    io.to(roomCode).emit('room:winner-chosen', {
      index,
      playerName: entry.playerName,
      scoreboard: buildScoreboard(room)
    });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });

  // ---- Judge advances to the next round (or ends the game) ----
  socket.on('judge:next-round', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== getCurrentJudgeId(room)) return;
    if (room.reveal.winnerIndex === null) return; // must crown a winner first

    advanceRoundOrEndGame(room, roomCode);
  });

  // ---- Disconnect handling ----
  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (socket.data.role === 'host') {
      io.to(roomCode).emit('room:host-left');
      rooms.delete(roomCode);
      return;
    }

    const player = room.players.get(socket.id);

    // Once the game has started, keep a disconnected player's data (score, pick, place in the
    // judge rotation) so they can reclaim it by rejoining with the same name — only remove them
    // outright if they were still just sitting in the lobby, where there's nothing to preserve.
    // If the current judge disconnects, the round simply waits for them to reconnect rather
    // than being auto-skipped, since they can now pick back up right where they left off.
    if (room.gameStarted && player) {
      player.connected = false;
    } else {
      room.players.delete(socket.id);
    }

    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });
});

server.listen(PORT, () => {
  console.log(`Queue It Up! server running at http://localhost:${PORT}`);
  console.log(`Host screen:   http://localhost:${PORT}/host.html`);
  console.log(`Player screen: http://localhost:${PORT}/`);
  if (!YOUTUBE_API_KEY) {
    console.log('Note: YOUTUBE_API_KEY not set — custom-start-time search will show an error until you add one to .env');
  }
});
