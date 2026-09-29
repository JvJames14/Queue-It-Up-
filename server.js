require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Tighter heartbeat than the defaults (25s interval / 20s timeout, up to ~45s worst case) —
// on a TV/console device especially, a flaky Wi-Fi connection can go "zombie" (the browser
// still thinks it's connected, but no packets are actually getting through) well before the
// default settings would notice and force a real reconnect. Detecting that faster means the
// existing reconnect-and-resync logic kicks in sooner instead of leaving a stale, silently
// broken connection in place for tens of seconds.
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000
});
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
// YouTube's API returns titles/channel names with HTML entities already encoded
// (e.g. "Don&#39;t Stop" instead of "Don't Stop") — decode them here so they display
// correctly instead of showing the raw entity codes.
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

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
      title: decodeHtmlEntities(item.snippet.title),
      channel: decodeHtmlEntities(item.snippet.channelTitle),
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
  "Play a song that everybody loves, but you secretly hate",
  "Play the song that best describes the vibe of your last existential crisis",
  "Play a song with an iconic intro",
  "Play a song that instantly makes you want to drop everything and do a terrible, aggressive air-guitar solo",
  "Play the song you passionately belted out as a kid, despite being way too young to understand or relate to a single word of it",
  "Play the song you used to dramatically stare out the car window to, pretending you were the heartbroken main character in a music video",
  "Play the absolute worst, most inappropriate song to have fading in as your casket is slowly lowered into the ground",
  "Play the song you want playing as your ghost aggressively haunts the people who didn't show up to your funeral",
  "Play the song that feels like a punch to the gut every single time, even when your life is going completely fine",
  "Play a song with a melody so hauntingly sad that the instrumental alone could make a room full of people tear up",
  "Play the song you'd use to communicate with aliens to prove that humanity is actually worth saving",
  "Play a song where the beat is so catchy and upbeat that most people never realize the lyrics are completely unhinged",
  "Play a track where the artist sounds like they genuinely lost their mind in the recording booth and nobody stopped them",
  "Play the song that once you hear three seconds of it, it stays in your head for three business days",
  "Play the theme song, commercial jingle, or viral track that has lived rent-free in your head since 2008",
  "Play the song you'd blast outside your ex's window at 3:00 AM",
  "Play the song that feels like a middle finger in audio form",
  "Play the song that feels like the ultimate, chaotic soundtrack for arson and destruction",
  "Play a song with lyrics so cryptically weird nobody in the room has any idea what the artist is actually talking about",
  "Play the song that should be playing while a team of criminal masterminds executes a high-stakes casino robbery",
  "Play the song that plays when the hero realizes you were the bad guy the entire time",
  "Play the song that instantly transports you back to standing awkwardly on the edge of a gym floor under dim lighting",
  "Play the track you blasted on loop the second you got your driver's license and total freedom",
  "Play the ultimate island track that feels like holding a cold drink with a tiny paper umbrella in it",
  "Play the song the President secretly listens to in the Oval Office with noise-canceling headphones when no advisors are watching",
  "Play the song you think an undercover cop puts on in their unmarked cruiser to try and look \"cool and hip\" with the kids",
  "Play the song an astronaut blasts inside their spacesuit while quietly staring at the void of deep space and floating in zero gravity",
  "Play the song a sweet grandma listens to while cruising down the highway at 35 mph, completely convinced she's living a life of pure crime and danger",
  "Play the track Snoop Dogg puts on when he's just casually baking brownies in the kitchen with Martha Stewart",
  "Play the song that plays in Julius Caesar's head the exact second he turns around, locks eyes with Brutus, and whispers \"Et tu, Brute?\"",
  "Play the track the band on the Titanic should have played if they decided to throw a full-blown chaotic dance party instead of staying formal",
  "Play the absolute chaos anthem that would be blasting while a group of angry colonists dumps millions of dollars of British tea into the Boston Harbor under the cover of night",
  "Play the track King George III would listen to in a dark room after receiving the letter explaining that Boston harbor is now a giant cup of salted Earl Grey",
  "Play the song that feels like standing in the middle of Woodstock in 1969 surrounded by half a million people, mud, and pure musical history",
  "Play the song that blasts over the stadium loudspeakers the exact second a streaker jumps the fence and starts dodging security guards on the field",
  "Play the track Newton put on right after getting hit on the head by an apple to act like inventing gravity was his plan all along",
  "Play the absolute unhinged party anthem that should have blasted across the entire country the exact second the 21st Amendment was ratified on December 5, 1933",
  "Play the track you'd play while cracking open a cold, legal beer for the first time since 1920, staring into the sunset like a freed prisoner due to prohibition",
  "Play the petty anthem a 1920 saloon owner blasts on the final night before Prohibition kicks in at midnight, determined to empty every single barrel",
  "Play the track Mother Nature blasts on full volume when she decides a specific town needs three tornados, a heatwave, and a sudden snowstorm all in the same weekend",
  "Play the song Santa puts on when he catches a local crew trying to hotwire his reindeer and steal the velvet toy bag off his sleigh",
  "Play the song Santa Claus blasts in his noise-canceling headphones while dumping 50 pounds of coal onto the bedroom floor of an absolute menace",
  "Play the song the Tooth Fairy listens to while deducting 75% of the cash value because the tooth is covered in cavity spots and sugar rot",
  "Play the track Willy Wonka queues up to announce he is handing the keys to a billion-dollar OSHA nightmare of a factory over to an 11-year-old child",
  "Play the song Snape listens to in his dark dungeon while aggressively taking 50 points from Gryffindor for someone breathing too loudly in Potions class",
  "Play the song that instantly starts playing in your head the moment the Sorting Hat shouts \"HUFFLEPUFF!\"",
  "Play the track the Bermuda Triangle radio operator puts on when another cargo ship vanishes off the radar and they just mark it down as a standard Tuesday",
  "Play the song you blast on your commute home after clocking out on a Friday afternoon",
  "Play the villain song from an animated movie that goes so unnecessarily hard you end up low-key rooting for the bad guy",
  "Play the song specifically made for a movie that had zero business going as hard as it did",
  "Play the Disney song that's an absolute bop, zero nostalgia required",
  "Play a song by an artist who left us way too soon, knowing they had so many hits left in them",
  "Play a song with an animal in the title that is a total bop",
  "Play a song that describes the exact feeling of unbuttoning your pants after a massive meal",
  "Play the song that plays in your head when you invite someone over to \"watch a movie\" with zero intention of finishing the movie",
  "Play the track that plays when the movie ends and you realize your \"Netflix and chill\" night was strictly just a movie night",
  "Play the song where every former theater kid in the room will automatically belt out",
  "Play a song that would make a great graduation song",
  "Play the song that starts playing in your head ten minutes into the date when you realize there is zero chemistry and you are just waiting for an acceptable time to leave",
  "Play the emo song that instantly makes you want to flip your side-swept fringe, put on heavy black eyeliner, and update your MySpace status",
  "Play the song that used to be your absolute highest-volume, most embarrassing ringtone or alarm back in the day",
  "Play the song from a Christian pop-punk or alt-rock band that secretly slapped, even if you weren't religious",
  "Play the heavy, dramatic beat drop that plays in your head during Lucifer's 10,000-mile-per-hour fall from grace",
  "Play the intense, high-anxiety song you put on while pacing the deck of Noah's Ark, trying to keep two starving lions away from the two innocent gazelles",
  "Play the song that served as Jesus's official walkout music when he exited the tomb on day three",
  "Play the claustrophobic, aquatic track you listen to while sitting inside the stomach of a giant whale for three days rethinking all your life choices",
  "Play a song that is explicitly about crime and has no business being an absolute banger",
  "Play the song that would be automatically blasting at 100% volume the second someone landed on your 2006 MySpace profile",
  "If MySpace made a comeback today, play the track you'd set as your main profile song",
  "Play the song that blasts in your head the exact second you snap all six Infinity Stones into your gauntlet and gain ultimate power over the universe",
  "Play your favorite one hit wonder"
];

const MAX_ACTIVE_PLAYERS = 8;
const ROUND_OPTIONS = [5, 10, 15];

/** rooms: Map<code, {
 *   hostSocketId, hostDisconnectTimer,        // the TV device — pure display, no game controls of its own
 *   controllerSocketId,                       // a player — drives the whole game (was called "judge"/"leader" before)
 *   phase: 'lobby'|'picking'|'reveal'|'game-over',
 *   prompt, promptIndex, seenPromptIndexes,
 *   players: Map<socketId, { name, role: 'active'|'audience', pick, hasPicked, score, connected }>,
 *   gameStarted, currentRoundNumber, totalRounds,   // totalRounds is now a flat 5/10/15, not multiplied by player count
 *   reveal: { picks: [{playerSocketId, playerName, track}], revealIndex, subPhase: 'sequential'|'choosing',
 *             nowPlayingIndex, votes: Map<voterSocketId, votedPickIndex>, canAdvance, advanceTimer } | null
 * }>
 */
const rooms = new Map();
// Maps an old room code to whatever it was replaced by (via "Create New Room"), so a player
// who was disconnected at that moment — and therefore never got the message telling them to
// rejoin under the new code — doesn't just silently fail when their browser eventually tries
// to reconnect using the old one it still has saved.
const roomRedirects = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function pickPrompt(excludeIndexes) {
  const excluded = excludeIndexes instanceof Set ? excludeIndexes : new Set(excludeIndexes != null ? [excludeIndexes] : []);
  const pool = excluded.size >= PROMPTS.length ? new Set() : excluded;
  let idx;
  do {
    idx = Math.floor(Math.random() * PROMPTS.length);
  } while (pool.has(idx));
  return idx;
}

function clampRounds(n) {
  const num = Number(n);
  if (ROUND_OPTIONS.includes(num)) return num;
  return 5;
}

function activePlayers(room) {
  return Array.from(room.players.entries()).filter(([, p]) => p.role === 'active');
}

function playerListPayload(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.role,
    hasPicked: p.hasPicked,
    hasVoted: room.reveal ? room.reveal.votes.has(id) : false,
    score: p.score,
    isController: id === room.controllerSocketId,
    connected: p.connected !== false
  }));
}

function allActivePicked(room) {
  const active = activePlayers(room);
  return active.length > 0 && active.every(([, p]) => p.hasPicked);
}

// Everyone currently connected (active + audience) is expected to cast one vote per round.
function allVoted(room) {
  if (!room.reveal) return false;
  const everyone = Array.from(room.players.entries()).filter(([, p]) => p.connected !== false);
  return everyone.length > 0 && everyone.every(([id]) => room.reveal.votes.has(id));
}

function buildScoreboard(room) {
  return Array.from(room.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function emitStartError(room, error) {
  if (room.controllerSocketId) io.to(room.controllerSocketId).emit('room:start-game-error', { error });
}

function controllerName(room) {
  const c = room.players.get(room.controllerSocketId);
  return c?.name || 'Unknown';
}

function startRound(room, roomCode) {
  const previousPromptIndex = room.promptIndex;
  room.promptIndex = pickPrompt(previousPromptIndex != null ? new Set([previousPromptIndex]) : undefined);
  room.prompt = PROMPTS[room.promptIndex];
  room.seenPromptIndexes = new Set([room.promptIndex]);
  room.phase = 'picking';
  room.reveal = null;
  for (const p of room.players.values()) {
    p.pick = null;
    p.hasPicked = false;
  }

  io.to(roomCode).emit('room:round-started', {
    roundNumber: room.currentRoundNumber,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    controllerName: controllerName(room)
  });
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

// Forcibly ends the game right now, whatever phase it's in — used by the host's "End Game"
// button. Mirrors the natural end-of-game path (same event, same scoreboard), just triggered
// manually instead of by finishing the last round.
function endGameNow(room, roomCode) {
  if (room.reveal?.advanceTimer) clearTimeout(room.reveal.advanceTimer);
  room.phase = 'game-over';
  room.reveal = null;
  io.to(roomCode).emit('room:game-over', { scoreboard: buildScoreboard(room) });
}

// Replays the sequence of setup events a reconnecting player needs to land back in the
// correct spot — reusing the SAME client-side handlers a fresh round already relies on.
function sendCatchUpState(socket, room) {
  if (room.phase === 'game-over') {
    socket.emit('room:game-over', { scoreboard: buildScoreboard(room) });
    return;
  }
  if (!room.gameStarted) return; // still in the lobby — nothing to catch up on

  socket.emit('room:round-started', {
    roundNumber: room.currentRoundNumber,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    controllerName: controllerName(room)
  });

  const me = room.players.get(socket.id);

  if (room.phase === 'picking') {
    if (me?.role === 'active' && me.hasPicked) {
      socket.emit('room:already-picked');
    }
    if (socket.id === room.controllerSocketId && allActivePicked(room)) {
      socket.emit('room:all-picked');
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
      if (me && room.reveal.votes.has(socket.id)) {
        socket.emit('room:vote-recorded', { index: room.reveal.votes.get(socket.id) });
      }
      if (room.reveal.resultsRevealed) {
        const voteCounts = new Array(room.reveal.picks.length).fill(0);
        for (const votedIndex of room.reveal.votes.values()) {
          if (voteCounts[votedIndex] !== undefined) voteCounts[votedIndex] += 1;
        }
        socket.emit('room:results-revealed', { voteCounts, scoreboard: buildScoreboard(room) });
      } else if (socket.id === room.controllerSocketId && allVoted(room)) {
        socket.emit('room:all-voted');
      }
    }
  }
}

// Host-equivalent of sendCatchUpState — the TV is pure display now, so it just needs to
// know what to SHOW, not who's allowed to do what.
function sendHostCatchUpState(socket, room) {
  socket.emit('room:players-updated', playerListPayload(room));

  if (room.phase === 'game-over') {
    socket.emit('room:game-over', { scoreboard: buildScoreboard(room) });
    return;
  }
  if (!room.gameStarted) return;

  socket.emit('room:round-started', {
    roundNumber: room.currentRoundNumber,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    controllerName: controllerName(room)
  });

  if (room.phase === 'reveal' && room.reveal) {
    socket.emit('room:reveal', {
      picks: room.reveal.picks.map(({ playerName, track }) => ({ playerName, track })),
      revealIndex: room.reveal.revealIndex,
      subPhase: room.reveal.subPhase
    });
    if (room.reveal.subPhase === 'choosing') {
      socket.emit('room:reveal-choosing');
      // If results were already revealed before this reconnect, resend them too — otherwise
      // the display resets to the plain pre-results vote list, silently wiping the vote
      // counts/winner badges that were already showing.
      if (room.reveal.resultsRevealed) {
        const voteCounts = new Array(room.reveal.picks.length).fill(0);
        for (const votedIndex of room.reveal.votes.values()) {
          if (voteCounts[votedIndex] !== undefined) voteCounts[votedIndex] += 1;
        }
        socket.emit('room:results-revealed', { voteCounts, scoreboard: buildScoreboard(room) });
      }
    } else if (room.reveal.nowPlayingIndex !== null && room.reveal.nowPlayingIndex !== undefined) {
      const entry = room.reveal.picks[room.reveal.nowPlayingIndex];
      if (entry) {
        socket.emit('room:now-playing', { index: room.reveal.nowPlayingIndex, track: entry.track, playerName: entry.playerName });
      }
    }
  }
}

io.on('connection', (socket) => {

  // ---- Host creates a room (TV device — pure display, all game controls now live on the
  // controller's phone) ----
  socket.on('host:create-room', (_data, ack) => {
    const code = makeRoomCode();
    rooms.set(code, {
      hostSocketId: socket.id,
      hostDisconnectTimer: null,
      controllerSocketId: null,
      phase: 'lobby',
      prompt: null,
      promptIndex: null,
      players: new Map(),
      gameStarted: false,
      selectedTotalRounds: 5, // live-synced from the controller's phone for the host screen to display
      currentRoundNumber: 0,
      totalRounds: 0,
      reveal: null
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'host';
    ack?.({ ok: true, code, joinBaseUrl: getJoinBaseUrl(socket) });
  });

  // ---- Host reconnects to a room it already created ----
  socket.on('host:resume-room', ({ code }, ack) => {
    const roomCode = (code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false });

    if (room.hostDisconnectTimer) {
      clearTimeout(room.hostDisconnectTimer);
      room.hostDisconnectTimer = null;
    }
    room.hostSocketId = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.role = 'host';

    ack?.({ ok: true, code: roomCode, joinBaseUrl: getJoinBaseUrl(socket) });
    sendHostCatchUpState(socket, room);
  });

  // ---- Host actively polls the current player list as a safety net alongside the normal
  // push-based 'room:players-updated' broadcasts, in case any single broadcast is missed for
  // any reason (network hiccup, dropped packet, etc.) — this way the display self-corrects
  // within a few seconds regardless of exactly why a specific update didn't land. ----
  socket.on('host:request-players', (_data, ack) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false });
    ack?.({
      ok: true,
      players: playerListPayload(room),
      phase: room.phase,
      reveal: room.reveal ? {
        picks: room.reveal.picks.map(({ playerName, track }) => ({ playerName, track })),
        revealIndex: room.reveal.revealIndex,
        subPhase: room.reveal.subPhase,
        nowPlayingIndex: room.reveal.nowPlayingIndex
      } : null
    });
  });

  // ---- Player joins a room ----
  // The first 8 to join become "active" players (search + submit + vote); anyone after
  // that joins as an "audience" member (vote only, no submissions, no player cap). The
  // very first person to join becomes the controller — the player who drives the whole
  // game (starting it, revealing picks, advancing rounds) — until/unless they hand it off.
  socket.on('player:join', ({ code, name }, ack) => {
    let roomCode = (code || '').trim().toUpperCase();
    let room = rooms.get(roomCode);
    // Follow any chain of redirects (e.g. "Create New Room" happened while this player was
    // disconnected, or happened more than once before they reconnected) to find whatever
    // room they should actually land in now, instead of just failing because the code they
    // still have saved points at something that no longer exists.
    let wasRedirected = false;
    while (!room && roomRedirects.has(roomCode)) {
      roomCode = roomRedirects.get(roomCode);
      room = rooms.get(roomCode);
      wasRedirected = true;
    }
    if (!room) return ack?.({ ok: false, error: 'Room not found. Check the code.' });

    const cleanName = (name || '').trim().slice(0, 16) || 'Player';

    // Reconnection: if this name matches someone who disconnected mid-game, reclaim their
    // existing slot (role, score, current pick all preserved) instead of a fresh join.
    // Matches on the connected flag OR on the old socket genuinely no longer being a live
    // connection — a page refresh opens the new connection and can send this join request
    // before the server has finished processing the old connection's disconnect event, so
    // relying on the flag alone is a real timing race. Checking the actual connection
    // registry sidesteps that: if the old socket is truly gone, this is a legitimate
    // reconnect regardless of whether our own bookkeeping has caught up yet.
    const reconnectEntry = Array.from(room.players.entries())
      .find(([id, p]) => id !== socket.id && p.name.toLowerCase() === cleanName.toLowerCase()
        && (p.connected === false || !io.sockets.sockets.has(id)));

    if (reconnectEntry) {
      const [oldSocketId, playerData] = reconnectEntry;
      room.players.delete(oldSocketId);
      playerData.connected = true;
      room.players.set(socket.id, playerData);

      if (room.controllerSocketId === oldSocketId) room.controllerSocketId = socket.id;
      if (room.reveal && room.reveal.picks) {
        room.reveal.picks.forEach(p => { if (p.playerSocketId === oldSocketId) p.playerSocketId = socket.id; });
      }
      if (room.reveal && room.reveal.votes.has(oldSocketId)) {
        const v = room.reveal.votes.get(oldSocketId);
        room.reveal.votes.delete(oldSocketId);
        room.reveal.votes.set(socket.id, v);
      }

      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.role = 'player';

      // This was missing role/isController entirely — meaning a reconnecting client never
      // learned it was still the controller (or still active/audience), even though the
      // server-side state was already correctly preserved/transferred above. The client only
      // sets isController when the ack explicitly says so, so this silently left a
      // reconnecting controller's own client thinking it wasn't the controller at all —
      // showing stale/wrong UI until something else (like a manual handoff) corrected it.
      ack?.({ ok: true, reconnected: true, role: playerData.role, isController: socket.id === room.controllerSocketId, code: wasRedirected ? roomCode : undefined });
      sendCatchUpState(socket, room);
      io.to(roomCode).emit('room:players-updated', playerListPayload(room));
      return;
    }

    // ---- Fresh join ----
    if (room.gameStarted) {
      return ack?.({ ok: false, error: 'This game already started. Ask the controller to open a new room.' });
    }
    const nameTaken = Array.from(room.players.values())
      .some(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (nameTaken) {
      return ack?.({ ok: false, error: 'That name is already taken in this room — pick another.' });
    }

    const activeCount = activePlayers(room).length;
    const role = activeCount < MAX_ACTIVE_PLAYERS ? 'active' : 'audience';

    room.players.set(socket.id, { name: cleanName, role, pick: null, hasPicked: false, score: 0, connected: true });
    // If this room was seeded with a specific person to hand control back to (see
    // host:create-new-room), honor that over the plain "first to join" rule — otherwise
    // whoever happens to be first to type in the new code becomes the new controller, which
    // could easily not be the person who was actually running the game a moment ago.
    if (room.pendingControllerName && cleanName.toLowerCase() === room.pendingControllerName.toLowerCase()) {
      room.controllerSocketId = socket.id;
      room.pendingControllerName = null;
    } else if (!room.controllerSocketId) {
      room.controllerSocketId = socket.id;
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.role = 'player';

    ack?.({ ok: true, role, isController: socket.id === room.controllerSocketId, code: wasRedirected ? roomCode : undefined });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
    io.to(roomCode).emit('room:player-joined', { name: cleanName });
  });

  // ---- Controller assigns a different player as the new controller ----
  socket.on('controller:assign-new-host', ({ playerId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.controllerSocketId) return;
    const targetPlayer = room.players.get(playerId);
    if (!targetPlayer) return;
    // A disconnected player's client isn't there to receive the resync this handoff sends —
    // it would only ever get sorted out once they manually reload the page. Blocking this
    // outright is simpler and safer than trying to make that resync work retroactively for a
    // connection that doesn't exist yet.
    if (targetPlayer.connected === false) return;

    const oldControllerId = room.controllerSocketId;
    room.controllerSocketId = playerId;
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));

    // "All picked" is normally sent once, reactively, only to whoever was controller at
    // that exact moment — if control changes hands afterward, the new controller never got
    // that signal and their "Reveal" button would be stuck disabled even though the
    // underlying condition is already true.
    if (room.phase === 'picking' && allActivePicked(room)) {
      io.to(playerId).emit('room:all-picked');
    }

    // Mid-reveal, BOTH sides of the handoff need a full resync, not just the new controller.
    // The new controller was previously just a passive viewer, so their controller panel has
    // never been populated. The old controller's viewer-panel is the mirror problem: it was
    // never being kept in sync while THEY held control (they were using the judge-specific
    // rendering path instead), so it's showing whatever was last there — potentially from an
    // entirely earlier round. Re-sending the current reveal state to both fixes both at once,
    // since each one's client-side handler already knows how to build the correct view based
    // on their current (just-updated) controller status.
    if (room.phase === 'reveal' && room.reveal) {
      [oldControllerId, playerId].forEach(id => {
        const targetSocket = io.sockets.sockets.get(id);
        if (!targetSocket) return;
        targetSocket.emit('room:reveal', {
          picks: room.reveal.picks.map(({ playerName, track }) => ({ playerName, track })),
          revealIndex: room.reveal.revealIndex,
          subPhase: room.reveal.subPhase
        });
        if (room.reveal.subPhase === 'choosing') {
          targetSocket.emit('room:reveal-choosing');
          if (room.reveal.votes.has(id)) {
            targetSocket.emit('room:vote-recorded', { index: room.reveal.votes.get(id) });
          }
        } else if (room.reveal.canAdvance) {
          // 'room:reveal' resets the client's "can advance" state to false unconditionally
          // (it doesn't know any better) — if the song had already finished playing (or its
          // minimum listen time had already elapsed) before this handoff happened, the "Next"
          // button needs to be explicitly re-signaled here, or it stays permanently hidden
          // with no future event left to ever re-enable it.
          targetSocket.emit('room:can-advance');
        }
      });
      if (room.reveal.subPhase === 'choosing' && allVoted(room)) {
        io.to(playerId).emit('room:all-voted');
      }
    }
  });

  // ---- Controller's rounds selection is live-synced to the host screen for display ----
  socket.on('controller:update-rounds', ({ totalRounds } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'game-over')) return;
    if (socket.id !== room.controllerSocketId) return;

    room.selectedTotalRounds = clampRounds(totalRounds);
    io.to(roomCode).emit('room:rounds-selected', { totalRounds: room.selectedTotalRounds });
  });

  // ---- Controller starts the game ----
  socket.on('start-game', ({ totalRounds } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.gameStarted) return;
    if (socket.id !== room.controllerSocketId) return;

    if (room.players.size < 3) {
      emitStartError(room, 'Need at least 3 players to start.');
      return;
    }

    room.totalRounds = clampRounds(totalRounds);
    room.currentRoundNumber = 1;
    room.gameStarted = true;
    startRound(room, roomCode);
  });

  // ---- Host force-ends the current game at any point, jumping straight to final scores ----
  socket.on('host:end-game', (_data, ack) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.gameStarted || room.phase === 'game-over') return ack?.({ ok: false });
    if (socket.id !== room.hostSocketId) return ack?.({ ok: false });
    endGameNow(room, roomCode);
    ack?.({ ok: true });
  });

  // ---- Host starts an entirely fresh room from the final-scores screen — no player
  // migration, since this is specifically for the "some/most players have left, start clean"
  // scenario rather than continuing with whoever's still around (that's what "Back to Lobby",
  // triggered by the controller, is for). ----
  socket.on('host:create-new-room', () => {
    const oldCode = socket.data.roomCode;
    const room = rooms.get(oldCode);
    if (!room || room.phase !== 'game-over') return;
    if (socket.id !== room.hostSocketId) return;

    const newCode = makeRoomCode();
    roomRedirects.set(oldCode, newCode);
    // Redirects don't need to live forever — clean up after a generous window so this never
    // grows unbounded across a long-running server process.
    setTimeout(() => roomRedirects.delete(oldCode), 10 * 60 * 1000);

    // Preserve who was running the game by name, not by socket id (which won't survive into
    // the new room) — otherwise the new room's "first to join becomes controller" rule turns
    // this into a race, and whoever's phone reconnects fastest ends up in charge instead of
    // the person who was actually running things, with no obvious way to tell why.
    const previousController = room.players.get(room.controllerSocketId);
    const pendingControllerName = previousController ? previousController.name : null;

    // This is specifically the "start over with a clean slate" action — force every
    // previously-connected player back to their join screen entirely, rather than leaving
    // them dangling in a room that's about to cease to exist. (Contrast with "Back to Lobby",
    // which is controller-driven and deliberately brings existing players along instead.)
    // Still send the new code along so their own screen can pre-fill it — "clean slate" means
    // a genuinely fresh room and role assignment, not that they have to go find the code again.
    for (const playerId of room.players.keys()) {
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.leave(oldCode);
        playerSocket.emit('room:kicked-to-join', { newCode });
      }
    }

    rooms.delete(oldCode);
    rooms.set(newCode, {
      hostSocketId: socket.id,
      hostDisconnectTimer: null,
      controllerSocketId: null,
      pendingControllerName,
      phase: 'lobby',
      prompt: null,
      promptIndex: null,
      players: new Map(),
      gameStarted: false,
      selectedTotalRounds: 5,
      currentRoundNumber: 0,
      totalRounds: 0,
      reveal: null
    });

    socket.leave(oldCode);
    socket.join(newCode);
    socket.data.roomCode = newCode;
    socket.emit('room:host-created-new-room', { code: newCode, joinBaseUrl: getJoinBaseUrl(socket) });
  });

  // ---- Controller restarts with fresh scores after game-over ----
  socket.on('play-again', ({ totalRounds } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'game-over') return;
    if (socket.id !== room.controllerSocketId) return;

    if (room.players.size < 3) {
      emitStartError(room, 'Need at least 3 players to start a new game.');
      return;
    }

    for (const p of room.players.values()) p.score = 0;
    room.totalRounds = clampRounds(totalRounds);
    room.currentRoundNumber = 1;
    room.gameStarted = true;
    io.to(roomCode).emit('room:play-again-sound');
    startRound(room, roomCode);
  });

  // ---- Controller returns to the lobby from final scores — players stay joined, scores
  // reset, ready to configure and start whenever the controller is ready. Generates a new
  // room code/QR for the fresh lobby, moving the host and every connected player over. ----
  socket.on('controller:back-to-lobby', () => {
    const oldCode = socket.data.roomCode;
    const room = rooms.get(oldCode);
    if (!room || room.phase !== 'game-over') return;
    if (socket.id !== room.controllerSocketId) return;

    // Fully end the old room and start a genuinely fresh one, rather than trying to
    // seamlessly move live socket connections across a code change — that approach broke
    // down whenever the host happened to be mid-reconnect (its 10-minute grace window) at
    // the exact moment "Back to Lobby" was pressed: with no live host socket to move, the
    // host was left silently stranded pointing at a room code that had just been deleted,
    // which is exactly what produced the stuck final-scores screen and the dead Start
    // button. This way, every device is told explicitly where to go, and reconnects the
    // same way a fresh join already works — no assumptions about who's currently connected.
    const newCode = makeRoomCode();
    const oldHostSocketId = room.hostSocketId;
    const oldPlayers = new Map(room.players);

    rooms.delete(oldCode);
    rooms.set(newCode, {
      hostSocketId: null,
      hostDisconnectTimer: null,
      controllerSocketId: null,
      phase: 'lobby',
      prompt: null,
      promptIndex: null,
      players: new Map(),
      gameStarted: false,
      selectedTotalRounds: 5,
      currentRoundNumber: 0,
      totalRounds: 0,
      reveal: null
    });

    const hostSocket = oldHostSocketId ? io.sockets.sockets.get(oldHostSocketId) : null;
    if (hostSocket) {
      hostSocket.leave(oldCode);
      hostSocket.emit('room:rejoin-new-room', { code: newCode, joinBaseUrl: getJoinBaseUrl(hostSocket) });
    }

    for (const [playerId, p] of oldPlayers.entries()) {
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.leave(oldCode);
        playerSocket.emit('room:rejoin-new-room', { code: newCode, name: p.name });
      }
    }
  });

  // ---- Controller removes a player from the lobby ----
  socket.on('controller:remove-player', ({ playerId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    // Allowed in the lobby (before/between games) and at game-over (deciding who's still in
    // before heading back to the lobby) — not mid-game, where it could disrupt an active round.
    if (!room || (room.phase !== 'lobby' && room.phase !== 'game-over')) return;
    // Either the controller (from their phone) or the host (TV) can remove a stale player.
    if (socket.id !== room.controllerSocketId && socket.id !== room.hostSocketId) return;
    if (!room.players.has(playerId)) return;

    const wasController = playerId === room.controllerSocketId;
    room.players.delete(playerId);
    if (wasController) {
      // Hand off to whoever's left, if anyone, rather than leaving the room without a controller.
      room.controllerSocketId = room.players.keys().next().value || null;
    }

    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
      playerSocket.emit('room:removed-by-host');
      playerSocket.disconnect(true);
    }
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });

  // ---- Active player submits/updates their pick ----
  socket.on('player:submit-pick', (track) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;

    const player = room.players.get(socket.id);
    if (!player || player.role !== 'active') return;

    player.pick = track;
    player.hasPicked = true;
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
    io.to(roomCode).emit('room:pick-submitted', { playerName: player.name });

    if (allActivePicked(room) && room.controllerSocketId) {
      io.to(room.controllerSocketId).emit('room:all-picked');
    }
  });

  // ---- Controller requests a new random prompt mid-round ----
  socket.on('controller:new-prompt', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;
    if (socket.id !== room.controllerSocketId) return;

    room.promptIndex = pickPrompt(room.seenPromptIndexes);
    room.prompt = PROMPTS[room.promptIndex];
    room.seenPromptIndexes.add(room.promptIndex);
    for (const p of room.players.values()) {
      p.pick = null;
      p.hasPicked = false;
    }
    io.to(roomCode).emit('room:prompt-changed', { prompt: room.prompt });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });

  // ---- Controller starts the reveal ----
  socket.on('controller:start-reveal', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'picking') return;
    if (socket.id !== room.controllerSocketId || !allActivePicked(room)) return;

    const picks = activePlayers(room)
      .filter(([, p]) => p.hasPicked && p.pick)
      .map(([id, p]) => ({ playerSocketId: id, playerName: p.name, track: p.pick }))
      .sort(() => Math.random() - 0.5);

    room.reveal = { picks, revealIndex: 0, subPhase: 'sequential', nowPlayingIndex: null, votes: new Map(), canAdvance: false, advanceTimer: null };
    room.phase = 'reveal';
    io.to(roomCode).emit('room:reveal', {
      picks: picks.map(({ playerName, track }) => ({ playerName, track })),
      revealIndex: 0,
      subPhase: 'sequential'
    });
  });

  // ---- Controller plays a specific pick (audio/video actually plays on the TV device) ----
  socket.on('controller:play-pick', (index) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== room.controllerSocketId) return;
    if (room.reveal.subPhase === 'sequential' && index !== room.reveal.revealIndex) return;
    const entry = room.reveal.picks[index];
    if (!entry) return;

    room.reveal.nowPlayingIndex = index;
    io.to(roomCode).emit('room:now-playing', { index, track: entry.track, playerName: entry.playerName });

    if (room.reveal.subPhase === 'sequential' && !room.reveal.canAdvance) {
      clearTimeout(room.reveal.advanceTimer);
      const revealAtStart = room.reveal;
      room.reveal.advanceTimer = setTimeout(() => {
        if (room.reveal !== revealAtStart || room.reveal.revealIndex !== index) return;
        room.reveal.canAdvance = true;
        // Use the room's CURRENT controller, not the socket that happened to call
        // controller:play-pick when this timer was originally set — if a handoff happened
        // in the meantime, that original caller may no longer be the controller at all, and
        // sending it there would leave whoever's actually in control with no signal ever
        // telling them the "Next" button should appear.
        if (room.controllerSocketId) io.to(room.controllerSocketId).emit('room:can-advance');
      }, 3000);
    }
  });

  // ---- Controller stops playback ----
  socket.on('controller:stop-playback', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.reveal) return;
    if (socket.id !== room.controllerSocketId) return;

    room.reveal.nowPlayingIndex = null;
    if (!room.reveal.canAdvance) clearTimeout(room.reveal.advanceTimer);
    io.to(roomCode).emit('room:stop-playback');
  });

  // ---- Controller advances from the current pick to the next one ----
  socket.on('controller:next-pick', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== room.controllerSocketId) return;
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
  socket.on('host:playback-ended', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.hostSocketId || !room.reveal) return;

    room.reveal.nowPlayingIndex = null;
    if (room.reveal.subPhase === 'sequential' && !room.reveal.canAdvance) {
      clearTimeout(room.reveal.advanceTimer);
      room.reveal.canAdvance = true;
      if (room.controllerSocketId) io.to(room.controllerSocketId).emit('room:can-advance');
    }
    io.to(roomCode).emit('room:stop-playback');
  });

  // ---- Any player or audience member casts their vote for this round's favorite song —
  // everyone gets exactly one vote, and can't vote for their own submission ----
  socket.on('player:cast-vote', (index) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (room.reveal.subPhase !== 'choosing') return;

    const entry = room.reveal.picks[index];
    if (!entry) return;
    if (entry.playerSocketId === socket.id) return; // can't vote for your own song

    // Tapping the song you already voted for deselects it; tapping a different one changes
    // your vote to that song instead.
    if (room.reveal.votes.get(socket.id) === index) {
      room.reveal.votes.delete(socket.id);
      socket.emit('room:vote-recorded', { index: null });
    } else {
      room.reveal.votes.set(socket.id, index);
      socket.emit('room:vote-recorded', { index });
    }
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));

    if (allVoted(room) && room.controllerSocketId) {
      io.to(room.controllerSocketId).emit('room:all-voted');
    } else if (room.controllerSocketId) {
      // A deselect (or a vote changing hands) can make an already-complete tally incomplete
      // again — make sure "Reveal results" doesn't stay enabled if that happens.
      io.to(room.controllerSocketId).emit('room:vote-incomplete');
    }
  });

  // ---- Controller reveals the results: tallies votes, awards 100 points per vote ----
  socket.on('controller:reveal-results', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== room.controllerSocketId) return;
    if (room.reveal.subPhase !== 'choosing') return;
    if (room.reveal.resultsRevealed) return;

    const voteCounts = new Array(room.reveal.picks.length).fill(0);
    for (const votedIndex of room.reveal.votes.values()) {
      if (voteCounts[votedIndex] !== undefined) voteCounts[votedIndex] += 1;
    }
    room.reveal.picks.forEach((entry, i) => {
      const points = voteCounts[i] * 100;
      if (points > 0) {
        const player = room.players.get(entry.playerSocketId);
        if (player) player.score += points;
      }
    });
    room.reveal.resultsRevealed = true;

    io.to(roomCode).emit('room:results-revealed', {
      voteCounts,
      scoreboard: buildScoreboard(room)
    });
    io.to(roomCode).emit('room:players-updated', playerListPayload(room));
  });

  // ---- Controller advances to the next round (or ends the game) ----
  socket.on('controller:next-round', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'reveal' || !room.reveal) return;
    if (socket.id !== room.controllerSocketId) return;
    if (!room.reveal.resultsRevealed) return;

    advanceRoundOrEndGame(room, roomCode);
  });

  // ---- Disconnect handling ----
  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (socket.data.role === 'host') {
      room.hostSocketId = null;
      room.hostDisconnectTimer = setTimeout(() => {
        io.to(roomCode).emit('room:host-left');
        rooms.delete(roomCode);
      }, 10 * 60 * 1000);
      return;
    }

    const player = room.players.get(socket.id);

    // Unified with the mid-game behavior: a dropped connection just gets flagged, not
    // removed — the lobby used to delete these entries outright (and immediately hand off
    // control if it was the controller who dropped), which meant a brief Wi-Fi hiccup while
    // still setting up could silently boot someone or reassign control out from under them.
    // Now they stay in the list showing "(reconnecting…)" exactly like mid-game, and the
    // host/controller can still manually remove them via "Manage players" if they never
    // come back.
    if (player) {
      player.connected = false;
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
