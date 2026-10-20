"""Flask + Flask-SocketIO entry point for the multiplayer Scrabble game.

The server is the single source of truth: clients only send *intents*
(place tiles, submit, pass, ...) and the server answers with per-player state
views (a full snapshot on join, then diffs on every mutation).

Run locally:   python app.py
Production:    gunicorn -c gunicorn.conf.py -k eventlet -w 1 app:app
"""
import os

# eventlet must be monkey-patched before anything else is imported.  If it is
# not installed we fall back to Flask-SocketIO's threading mode so that
# `python app.py` still works for quick local experiments.
try:
    import eventlet

    eventlet.monkey_patch()
    ASYNC_MODE = "eventlet"
except ImportError:  # pragma: no cover - depends on the local environment
    ASYNC_MODE = "threading"

import logging
from functools import wraps

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, join_room
from werkzeug.middleware.proxy_fix import ProxyFix

from game.board import GameError
from game.room import CONFIG, RULES, RoomRegistry, clean_name, diff_views

log = logging.getLogger("scrabble")

app = Flask(__name__)
# Railway / Render terminate TLS in front of us; trust one proxy hop so that
# request.host_url (used for the shareable link) has the right scheme and host.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _cors_origins():
    """CORS_ALLOWED_ORIGINS: unset = same origin only, '*' = anyone, or a comma list."""
    raw = os.environ.get("CORS_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return None
    if raw == "*":
        return "*"
    return [o.strip() for o in raw.split(",") if o.strip()]


socketio = SocketIO(
    app,
    async_mode=ASYNC_MODE,
    cors_allowed_origins=_cors_origins(),
    max_http_buffer_size=64 * 1024,  # clients only ever send tiny JSON messages
    ping_interval=20,
    ping_timeout=30,
)

REGISTRY = RoomRegistry()

# socket id -> (room code, player token).  A player's token survives
# reconnects; the socket id does not.
SESSIONS = {}


# --------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html", error=None)


@app.post("/create")
def create_room():
    """Create a room and return its 8-character code and shareable URL."""
    payload = request.get_json(silent=True)
    rules = "strict"
    if isinstance(payload, dict) and isinstance(payload.get("rules"), str):
        rules = payload["rules"]
    if rules not in RULES:
        return jsonify(error="Unknown rules. Use one of: " + ", ".join(RULES)), 400
    try:
        room = REGISTRY.create(rules)
    except GameError as exc:
        return jsonify(error=str(exc)), 503
    path = f"/join/{room.code}"
    return (
        jsonify(
            code=room.code,
            path=path,
            url=request.host_url.rstrip("/") + path,
            rules=room.rules,
        ),
        201,
    )


@app.get("/join/<code>")
def join_page(code):
    room = REGISTRY.get(code)
    if room is None:
        message = "That room was not found. It may have expired - ask for a new link or create a game."
        return render_template("index.html", error=message), 404
    return render_template("game.html", code=room.code, rules=room.rules)


@app.get("/api/room/<code>")
def room_info(code):
    """Lets the home page check whether a saved session is still worth rejoining."""
    room = REGISTRY.get(code)
    if room is None:
        return jsonify(exists=False)
    return jsonify(exists=True, status=room.status, players=len(room.players), rules=room.rules)


@app.get("/healthz")
def healthz():
    return "ok", 200, {"Content-Type": "text/plain; charset=utf-8"}


# --------------------------------------------------------------------------
# State broadcasting
# --------------------------------------------------------------------------
def push_all(room):
    """Send every connected player the change since the last thing they received.

    Views differ per player (own rack vs. opponent rack count), so we emit to
    individual socket ids rather than to the whole socket.io room.  A player
    with no baseline gets a full snapshot ("state"); everyone else gets a
    patch ("state_diff") carrying the version it applies on top of.
    """
    for player in room.players:
        if not (player.connected and player.sid):
            continue
        view = room.view_for(player)
        if player.sent_view is None:
            socketio.emit(
                "state",
                {"version": room.version, "config": CONFIG, "state": view},
                to=player.sid,
            )
        else:
            patch = diff_views(player.sent_view, view)
            if not patch:
                continue
            socketio.emit(
                "state_diff",
                {"base": player.sent_version, "version": room.version, "patch": patch},
                to=player.sid,
            )
        player.sent_view = view
        player.sent_version = room.version


# --------------------------------------------------------------------------
# Socket events
# --------------------------------------------------------------------------
@socketio.on("join")
def on_join(data=None):
    """Join a room, or rejoin it with a saved session token after a reconnect."""
    data = data if isinstance(data, dict) else {}
    room = REGISTRY.get(data.get("room"))
    if room is None:
        return {"ok": False, "code": "no_room", "error": "That room no longer exists."}
    token = data.get("token") if isinstance(data.get("token"), str) else ""
    with room.lock:
        player = room.player_by_token(token) if token else None
        if player is None:
            try:
                player = room.add_player(data.get("name"))
            except GameError as exc:
                return {"ok": False, "code": "full", "error": str(exc)}
        # (Re)bind this socket to the player.  Dropping the old baseline forces
        # a fresh full snapshot, which is also how a client resynchronises.
        player.sid = request.sid
        player.connected = True
        player.sent_view = None
        SESSIONS[request.sid] = (room.code, player.token)
        join_room(room.code)
        if room.status == "waiting" and len(room.players) == 2:
            room.start()
        room.touch()
        push_all(room)
        return {"ok": True, "token": player.token, "seat": player.seat, "room": room.code}


@socketio.on("disconnect")
def on_disconnect(*_args):
    info = SESSIONS.pop(request.sid, None)
    if info is None:
        return
    room = REGISTRY.get(info[0])
    if room is None:
        return
    with room.lock:
        player = room.player_by_token(info[1])
        # A refresh rebinds the player to a new socket before the old one
        # disconnects; only mark them offline if this socket is still theirs.
        if player is not None and player.sid == request.sid:
            player.connected = False
            player.sid = None
            room.touch()
            push_all(room)


def game_action(event):
    """Register a socket event that acts on the sender's room and player.

    The wrapped function receives (room, player, data) and either returns a
    dict of extra ack fields or raises GameError.  After a successful action
    every player is sent the resulting state change; the sender additionally
    gets an acknowledgement {"ok": True, ...} or {"ok": False, "error": ...}.
    """

    def decorator(fn):
        @wraps(fn)
        def handler(data=None):
            info = SESSIONS.get(request.sid)
            room = REGISTRY.get(info[0]) if info else None
            if room is None:
                return {"ok": False, "code": "no_session", "error": "You are not in a game. Reload the page."}
            with room.lock:
                player = room.player_by_token(info[1])
                if player is None:
                    return {"ok": False, "code": "no_session", "error": "You are not in a game. Reload the page."}
                try:
                    extra = fn(room, player, data if isinstance(data, dict) else {})
                except GameError as exc:
                    return {"ok": False, "error": str(exc)}
                except Exception:  # never leave the client's callback hanging
                    log.exception("Unhandled error in %s", event)
                    return {"ok": False, "error": "Server error. Please try again."}
                room.touch()
                push_all(room)
            return {"ok": True, **(extra or {})}

        return socketio.on(event)(handler)

    return decorator


@game_action("place_tiles")
def on_place_tiles(room, player, data):
    """Replace the player's tentative placement: {"placements": [{rack_index, row, col, letter?}]}."""
    room.place_tiles(player, data.get("placements"))


@game_action("submit_word")
def on_submit_word(room, player, data):
    """Commit the tentative placement: validate, score, draw tiles, pass the turn."""
    return room.submit(player)


@game_action("pass")
def on_pass(room, player, data):
    return room.pass_turn(player)


@game_action("swap_tiles")
def on_swap_tiles(room, player, data):
    """Exchange tiles with the bag: {"indices": [rack indices]}."""
    return room.swap(player, data.get("indices"))


@game_action("challenge_skip")
def on_challenge_skip(room, player, data):
    """Challenge the opponent's last play (challenge rules only).

    A failed challenge costs the challenger their turn - hence "skip".
    """
    return room.challenge(player)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    extra = {"allow_unsafe_werkzeug": True} if ASYNC_MODE == "threading" else {}
    print(f"Scrabble server ({ASYNC_MODE} mode) on http://{host}:{port}")
    socketio.run(app, host=host, port=port, debug=os.environ.get("FLASK_DEBUG") == "1", **extra)


# --------------------------------------------------------------------------
# TODO - ideas for future versions (deliberately out of scope for v1)
# --------------------------------------------------------------------------
# TODO: Persist rooms (SQLite/Redis) so games survive restarts and so more than
#       one gunicorn worker can be used (needs a Socket.IO message queue too).
# TODO: Accounts / auth instead of anonymous per-room session tokens.
# TODO: In-game chat and emoji reactions.
# TODO: AI opponent (anchor-square move generator over a DAWG/GADDAG).
# TODO: 3-4 player rooms (turn order, per-player challenges, end-game scoring).
# TODO: Swap in the full official dictionary (TWL/NWL or SOWPODS/Collins) and
#       let the room creator choose it.
# TODO: Turn timers / clocks and automatic forfeits for abandoned games.
# TODO: Rematch button, spectators, and a downloadable move log (GCG format).
# TODO: Rate-limit socket events and room creation per IP.
# TODO: Serve socket.io-client from /static instead of the CDN for offline use.
# TODO: Frontend tests (Playwright) and a Socket.IO integration test suite.
