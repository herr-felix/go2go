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
	offset = 6;

	constructor (board) {
		this.board = board;
		this.lines = this.board.getUint8(5);
		this.size = this.lines*this.lines;
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

	get playingColor() {
		return this.board.getUint8(0) & 3;
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
      	return idx - this.lines
			case LEFT:
				if (idx % this.lines == 0) {
					return this.size // Out
				}
				return idx - 1
			case RIGHT:
				if (idx % this.lines + 1 == this.lines) {
					return this.size // Out
				}
				return idx + 1;
			case DOWN:
				return idx + this.lines
			default:
				if (idx < 0 || idx >= this.size) {
					return OUT;
				}
				return this.board.getUint8(idx + this.offset)
		}
	}

	// Set color at idx
	setAt(idx, color) {
		this.board.setUint8(idx + this.offset, color)
	}

	async isRepeated(history) {
		if ((this.board.getUint8(0) & PASS_FLAG) || this.playingColor === OUT) {
			return false;
		}

		let board = this.board.buffer.slice(this.offset)
		let stoneCount = (new Uint8Array(board)).reduce((count, color) => color && count + 1 || count, 0);
		let boardChecksum = new BigUint64Array(await crypto.subtle.digest({name: 'SHA-256'}, board))

		let statesWithCount = history[stoneCount];
		// Have we ever had this stone count?
		if (statesWithCount) {
			console.log(statesWithCount)
			if (statesWithCount.some(x => x.every((b, i) => b === boardChecksum[i]))) {
				return true;
			}
			statesWithCount.push(boardChecksum)
		} else {
			history[stoneCount] = [boardChecksum]
		}

		return false;
	}

	// Set a mark (mask) at idx. Player connot mark it's own stones.
	markAs(pos, playerColor) {
		let current = this.at(pos);
		let currentColor = (current & 3);
		let currentMark = (current >> 2);

		var newMark = (playerColor << 2) | currentColor;

		// Can't mark your own stones, only unmark them
		if (current === playerColor) {
			return;
		} else if (currentMark === playerColor) {
			newMark = currentColor
		} else if (currentColor === playerColor) {
			newMark = currentColor
		}

		for (let marked of this.getGroup(pos).values()) {
			this.setAt(marked, newMark);
		}

		return true;
	}

	play (pos, color) {
		if (this.playingColor === OUT) {
			// We are counting points
			return this.markAs(pos, color)
		}

		if ((color & 3) !== this.playingColor) {
			return false // not it's turn to play
		}

		let op_color = color ^ 3; // Opposite color

		// Playing outside of the board is how you pass.
	  if (pos > this.size || pos < 0) {
			if (this.board.getUint8(0) >> 7) { // Is the "PASSED" bit set?
				// Previous turn was passed. This turn also. THE GAME IS OVER!
				this.board.setUint8(0, OUT) // When the playing color is OUT, it means that the game is over and the players are counting points
			} else {
				this.board.setUint8(0, PASS_FLAG | op_color) // Add the PASS_FLAG and change the playing color
				console.log('passing')
			}
			return true; // This is "passing"
		}

		// Remove the "passed" flag
		color = color & 3;

		//# Can only play on empty positions
		if (this.at(pos) !== EMPTY) {
			return false;
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
				if (this.isGroupDead(adjGroup)) {
					// captured = union(captured + adjGroup)
					for (const x of adjGroup.values()) {
						captured.add(x)
					}
  			} else {
					// alive = union(alive + adjGroup)
					for (const x of adjGroup.values()) {
						alive.add(x)
					}
				}
			}
		}

		// Group is dead and have no captured? Not a valid move
		if (captured.size == 0 && this.isGroupDead(this.getGroup(pos))) {
			return false // No a valid move
		}

		// Remove captured
		for (let c of captured.values()) {
			this.setAt(c, EMPTY)
		}

		// Stones have been captured! We update the points
		if (captured.size > 0) {
			let points_idx = color === BLACK ? 1 : 3;
			this.board.setUint16(points_idx, this.board.getUint16(points_idx, true) + captured.size, true);
		}

		// Set the playing color
		this.board.setUint8(0, op_color)

		return true
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

			let game = (await this.state.storage.get('game')) || {history: []};
			const canPlay = pid && pid !== game.black && pid !== game.white;

			let pair = new WebSocketPair();

			if (!game.board || canPlay) {
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

				if (!game.board) {
					game.board = new DataView(new ArrayBuffer(361 + 7))
					game.board.setUint8(0, 1) // Set black as first to play

					const size = (new URLSearchParams(url.search)).get('s')
					game.board.setUint8(5, decodeBoardSize(size)) // Set the board's size
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

		let msg = new Uint8Array(new ArrayBuffer(1))
		const color = pid === game.black ? BLACK : pid === game.white ? WHITE : EMPTY;

		if (color !== EMPTY) {
			ws.serializeAttachment(color);
			msg[0] = color || 0;
			ws.send(msg)
		}
		ws.send(game.board)
	}

	async webSocketMessage(ws, msg) {
		let dv = new DataView(msg);
		let playerColor = ws.deserializeAttachment()

		try {
		if (playerColor) {
			let game = await this.state.storage.get("game")
			let goban = new Goban(game.board)

			let pos = dv.getUint16(1, true);

			if (!goban.play(pos, playerColor)) {
				return // Not a legal move
			}

			// Check for state repetition
			if (await goban.isRepeated(game.history)) {
				return
			}

			await this.state.storage.put("game", game);
			this.broadcast(game.board);
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
