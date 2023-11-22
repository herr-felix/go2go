import HTML from "./index.html";

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const OUT = 3;

const UP = 1;
const RIGHT = 2;
const DOWN = 3;
const LEFT = 4;

const PASS_FLAG = 0x80;

const directions = [UP,RIGHT,DOWN,LEFT]

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

	  	return handleApiRequest(path[0], request, env);

    });
  }
}


async function handleApiRequest(name, request, env) {
	if (name.length > 32) {
		return new Response("Not found", {status: 404});
	}

	let gameObject = env.games.get(env.games.idFromName(name));

	let newUrl = new URL(request.url);
	newUrl.pathname = "/" + name

	return gameObject.fetch(newUrl, request);
}


class Goban {
	constructor (game) {
		this.game = game;
		this.size = this.game.lines*this.game.lines;
	}

	isGroupDead (group) {
		for (let pos of group.values()) {
			for (let dir of directions) {
				if (this.at(this.at(pos, dir)) == EMPTY) {
					return false
				}
			}
		}
		return true
	}

	getGroup (start) {
		let color = this.at(start)
		let cluster = new Set()
		if (color !== OUT) {
			let q = [start];

			while (q.length > 0) {
				let pos = q.pop();
				cluster.add(pos);
				for (let dir of directions) {
					let next = this.at(pos, dir);
					if (!cluster.has(next) && this.at(next) === color) {
						q.push(next);
					}
				}
			}
		}
		return cluster
	}

	// Returns the color at `idx`. If `direction` is precised, returns the idx at `direction` of idx.
	at (idx, direction) {
		switch (direction) {
			case UP:
      	return idx - this.game.lines
			case LEFT:
				if (idx % this.game.lines == 0) {
					return this.size // Out
				}
				return idx - 1
			case RIGHT:
				if (idx % this.game.lines + 1 == this.game.lines) {
					return this.size // Out
				}
				return idx + 1;
			case DOWN:
				return idx + this.game.lines
			default:
				if (idx < 0 || idx >= this.size) {
					return OUT;
				}
				return this.game.board[idx] || EMPTY
		}
	}

	// Set color at idx
	setAt(idx, color) {
		this.game.board[idx] = color;
	}

	async isRepeated(history) {
		const board = new Uint8Array(this.game.board)
		let stoneCount = board.reduce((count, color) => color && count + 1 || count, 0);
		let boardChecksum = new BigUint64Array(await crypto.subtle.digest({name: 'SHA-256'}, board))

		let statesWithCount = history[stoneCount];
		// Have we ever had this stone count?
		if (statesWithCount) {
			if (statesWithCount.some(x => x.every((b, i) => b === boardChecksum[i]))) {
				throw new TypeError("The board cannot repeat a previous state.");
			}
			statesWithCount.push(boardChecksum)
		} else {
			history[stoneCount] = [boardChecksum]
		}
	}

	get gameIsOver() {
		return this.game.moves.length > 0 && this.game.moves[this.game.moves.length - 1].length === 4;
	}

	get lastMove() {
		return this.game.moves.length > 0 && this.game.moves[this.game.moves.length - 1][0]
	}


	getMarked(color) {
		return this.game.board.reduce((acc, c, i) => {
			switch (c) {
				case (WHITE << 2) | BLACK: // Black prisoners
					acc[0].push(i);
					break;
				case (BLACK << 2) | WHITE: // White prisoners
					acc[1].push(i);
					break;
				case BLACK << 2: // Black territory
					acc[2].push(i);
					break;
				case WHITE << 2: // White territory
					acc[3].push(i);
					break;
			}
			return acc;
		}, [[], [], [], []])
	}

	// Set a mark (mask) at idx. Player connot mark it's own stones.
	markAs(pos, playerColor) {
		let current = this.at(pos);
		let currentColor = (current & 3);
		let currentMark = (current >> 2);

		var newMark = (playerColor << 2) | currentColor;

		// Can't mark your own stones, only unmark them
		if (current !== playerColor) {
			if (currentMark === playerColor || currentColor === playerColor) {
				newMark = currentColor
			}

			for (let marked of this.getGroup(pos).values()) {
				this.setAt(marked, newMark);
			}
		}

		return this.getMarked();
	}

	play (pos, color) {

		if (this.gameIsOver) {
			return this.markAs(pos, color);
		}

		if (this.lastMove === undefined && pos === null) {
			return this.getMarked();
		}

		if ((this.game.moves.length % 2 + 1) !== color) {
			throw new TypeError("Not color's turn");
		}

		let op_color = color ^ 3; // Opposite color

		// Playing outside of the board is how you pass.
	  if (pos === null) {
			return []; // This is "passing"
		}

		//# Can only play on empty positions
		if (this.at(pos) !== EMPTY) {
			throw new TypeError("Position is not empty");
		}

		let captured = new Set()
		let alive = new Set()

		// Play at pos
		this.setAt(pos, color);


		// Did we kill a group?
		for (let dir of directions) {
			const p = this.at(pos, dir)
			if (this.at(p) == op_color &&  !(alive.has(p) || captured.has(p))) {
				let adjGroup = this.getGroup(p)
				let deadOrAlive = this.isGroupDead(adjGroup) ? captured : alive;
				for (const x of adjGroup.values()) {
					deadOrAlive.add(x)
				}
			}
		}

		// Group is dead and have no captured? Not a valid move
		if (captured.size == 0 && this.isGroupDead(this.getGroup(pos))) {
			throw new TypeError("Suicides not allowed.");
		}

		// Remove captured
		for (let c of captured.values()) {
			this.setAt(c, EMPTY)
		}

		if (captured.size > 0) {
			return [pos, Array.from(captured.values())]
		}
		return [pos]
	}

}

function decodeBoardSize(size) {
	switch (size) {
		case "9":
			return 9;
		case "13":
			return 13;
		default:
			return 19;
	}
}

export class GoGame {
  constructor(state, env) {
		this.state = state;
	}

	async fetch(request) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);

			if (request.headers.get("Upgrade") != "websocket") {
				return new Response("expected websocket", {status: 400});
			}

			const pid = (new URLSearchParams(url.search)).get('p')

			let game = (await this.state.storage.get('game')) || {history: [], moves: [], board: []};
			const canPlay = pid && pid !== game.black && pid !== game.white;

			let pair = new WebSocketPair();

			if (!game.lines || canPlay) {
				if (canPlay) {
					const color = (new URLSearchParams(url.search)).get('c')

					if (!game.black && color == "b") {
						game.black = pid
					} else if (!game.white && color == "w") {
						game.white = pid
					} else if (!game.black) {
						game.black = pid
					} else if (!game.white) {
						game.white = pid
					}
				}

				if (!game.lines) {
					const size = (new URLSearchParams(url.search)).get('s')
					game.lines = decodeBoardSize(size) // Set the board's size
				}
				await this.state.storage.put("game", game)
				this.updateTTL();
			}

			await this.handleSession(pair[1], game, pid);

			return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

	async handleSession(ws, game, pid) {
  	this.state.acceptWebSocket(ws)

		const color = pid === game.black ? BLACK : pid === game.white ? WHITE : EMPTY;
		if (color !== EMPTY) {
			ws.serializeAttachment(color);
		}

		ws.send(JSON.stringify({color, size: game.lines, history: game.moves }))
	}

	async webSocketMessage(ws, msg) {
		let playerColor = ws.deserializeAttachment()

		try {
			if (playerColor) {
				let game = await this.state.storage.get("game")
				let goban = new Goban(game)

				const pos = JSON.parse(msg);

				// Play
				const move = goban.play(pos, playerColor)

				if (goban.gameIsOver) {
					game.moves.pop();
				} else if (move.length > 0 && move.length !== 4) { // Only check if we didn't pass
					// Check for state repetition
					await goban.isRepeated(game.history);
				}
				game.moves.push(move);

				await this.state.storage.put("game", game);
				this.broadcast(JSON.stringify(move));
				this.updateTTL();
			}
		} catch (err) {
			console.error(err);
		}
	}

	updateTTL() {
		this.state.storage.setAlarm(new Date((new Date()).getTime() + 86400000)) // Set alarm to now + 24h
	}

  webSocketClose(ws) {
		console.log(ws)
	}

	webSocketError(ws, msg) {
		console.error(msg)
	}

	broadcast(msg) {
		this.state.getWebSockets().forEach(sub => {
			try {
				sub.send(msg);
			} catch (err) {

			}
    });
	}

	async alarm() {
		await this.state.storage.deleteAll();
	}

}
